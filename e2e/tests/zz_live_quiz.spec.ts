import { devices, expect, test } from '@playwright/test';
import {
  choiceQuestion,
  confirmSubmit,
  csrfToken,
  deleteLesson,
  installAnswerResender,
  installTeacherSocketDropper,
  joinStudent,
  loginAndOpenQuizLesson,
  optionCount,
  recordReceivedFrames,
  releaseToBoundLine,
  runAndDecodeQr,
  SOURCE,
} from './live_quiz_helpers';

// 即時課堂走「薄中繼」：計分在老師的瀏覽器，伺服器只轉送。這份 spec 從瀏覽器像素
// 一路驗到老師畫面與收場上傳，不碰任何已移除的 HTTP 路由。
// 第一次按 Run 要在瀏覽器裡跑 clang.wasm 編譯，每個測試的上限放寬。
test.setTimeout(240_000);

const EXPLANATION = '程式已執行到指定行。';

test('student scans rendered QR, answers at the bound line, and the class ends with anonymous aggregates', async ({
  browser,
}) => {
  const teacher = await browser.newContext(devices['Desktop Chrome']);
  const teacherPage = await teacher.newPage();
  const phone = await browser.newContext(devices['iPhone 13']);
  const studentPage = await phone.newPage();
  const studentFrames = recordReceivedFrames(studentPage);
  let lessonId: number | null = null;
  let csrf = '';

  try {
    lessonId = await loginAndOpenQuizLesson(teacherPage, 'QR 即時作答 E2E', [choiceQuestion()]);
    csrf = await csrfToken(teacherPage);
    const liveButton = teacherPage.getByTestId('live-quiz-open');
    const savedSource = await teacherPage.evaluate(() =>
      (window as any).monaco.editor.getModels()[0].getValue()
    );
    await teacherPage.evaluate((source) => {
      (window as any).monaco.editor.getModels()[0].setValue(`${source}// 尚未儲存`);
    }, savedSource);
    await expect(liveButton).toBeDisabled();
    await teacherPage.evaluate((source) => {
      (window as any).monaco.editor.getModels()[0].setValue(source);
    }, savedSource);
    await expect(liveButton).toBeEnabled();
    // 「即時課堂」是預設已勾選的勾選框，面板一開始就在側欄裡；點它是取消勾選。
    await expect(liveButton).toBeChecked();

    // 動線：按 Run 開課並彈出全螢幕 QR（程式此時尚未開始跑）→ 從 QR 的像素解出網址、
    // 學生用那個網址加入 → 老師關掉 QR 放行 → 播放到綁定行時題目自動開出來。
    const { sessionId, joinUrl } = await runAndDecodeQr(teacherPage);
    await joinStudent(studentPage, joinUrl, '小明');
    await releaseToBoundLine(teacherPage);
    await expect(studentPage.getByRole('heading', { name: 'i 是多少？' })).toBeVisible();
    await expect(teacherPage.getByText('1 位學生已加入').first()).toBeVisible();
    for (const id of ['continue_button', 'next_button', 'step_button', 'return_button']) {
      await expect(teacherPage.locator(`#${id}`)).toBeDisabled();
    }

    // 情境 3（收卷前不洩題）：選項本身當然看得到，所以不能拿「選項文字不存在」當斷言；
    // 該斷言的是「正解標記、解說、結果區塊」都不在學生的畫面與收到的任何 socket 框架裡。
    await expect(studentPage.locator('.result-box')).toHaveCount(0);
    await expect(studentPage.locator('.answer-option.correct')).toHaveCount(0);
    await expect(studentPage.locator('.answer-mark')).toHaveCount(0);
    expect(await studentPage.content()).not.toContain(EXPLANATION);
    expect(await studentPage.locator('body').innerText()).not.toContain('正解');
    await expect.poll(() => studentFrames.join('\n')).toContain('i 是多少？'); // 確認真的有在看題目那個框架
    const beforeClose = studentFrames.join('\n');
    expect(beforeClose).not.toContain(EXPLANATION);
    expect(beforeClose).not.toContain('correct_option_id');

    await studentPage.getByLabel('1', { exact: true }).check();
    await confirmSubmit(studentPage, '送出答案');
    // 「已收到」要等老師端確認才出現
    await expect(studentPage.getByText('已收到答案，關題前仍可修改。')).toBeVisible();
    // 統計是老師瀏覽器算的
    await expect(teacherPage.getByText('已作答 1', { exact: true })).toBeVisible();
    await expect(teacherPage.getByText('答對 1', { exact: true })).toBeVisible();
    await expect.poll(() => optionCount(teacherPage, '1')).toBe(1);
    await expect.poll(() => optionCount(teacherPage, '0')).toBe(0);
    // 答案還在老師手上，學生端在收卷前仍然不能有正解
    await expect(studentPage.locator('.result-box')).toHaveCount(0);

    await teacherPage.getByRole('button', { name: '結束作答並繼續' }).click();
    await expect(studentPage.getByText('✓ 答對了')).toBeVisible();
    await expect(studentPage.getByText(EXPLANATION)).toBeVisible();
    await expect(studentPage.locator('.answer-option.correct')).toContainText('1');
    await expect(teacherPage.locator('#next_button')).toBeEnabled();

    // 情境 6：結束課堂 → 老師瀏覽器把匿名聚合上傳（POST .../end 回 200 + JSON）。
    // 順便守住結束後「載回最新教案」失敗可重試的流程（第一次 GET 教案回 500）。
    let restoreAttempts = 0;
    const lessonRoute = `**/api/lessons/${lessonId}`;
    await teacherPage.route(lessonRoute, async route => {
      if (route.request().method() === 'GET') {
        restoreAttempts += 1;
        if (restoreAttempts === 1) {
          await route.fulfill({ status: 500, body: '{"error":"temporary"}' });
          return;
        }
      }
      await route.continue();
    });
    const endRequest = teacherPage.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/live-quiz/sessions/${sessionId}/end`
    );
    await teacherPage.getByRole('button', { name: '結束課堂' }).click();
    const endResponse = await endRequest;
    expect(endResponse.status()).toBe(200);
    const uploaded = JSON.parse(endResponse.request().postData() || 'null');
    expect(uploaded).not.toBeNull(); // 不是空 body 的保底重送：真的帶了聚合
    const ended = await endResponse.json();
    expect(ended.id).toBe(sessionId);
    expect(ended.state).toBe('ended');
    expect(ended.questions[0].answer_count).toBe(1);
    expect(ended.questions[0].correct_count).toBe(1);

    await expect(teacherPage.getByRole('button', { name: '重試載入' })).toBeVisible();
    await expect(teacherPage.getByRole('button', { name: '關閉' })).toBeDisabled();
    await teacherPage.getByRole('button', { name: '重試載入' }).click();
    await expect.poll(() => teacherPage.evaluate(() =>
      (window as any).monaco.editor.getModels()[0].getValue()
    )).toBe(SOURCE);
    await teacherPage.unroute(lessonRoute);
    await expect(teacherPage.getByText('本次課堂已結束')).toBeVisible();
    await expect(teacherPage.getByRole('button', { name: '關閉' })).toBeEnabled();
    await expect(teacherPage.getByTestId('save-lesson-to-account')).toBeEnabled();
    await expect(studentPage.getByRole('heading', { name: '課堂已結束' })).toBeVisible();

    // 匿名彙總：伺服器只留聚合，沒有暱稱、沒有逐筆作答
    const summaryResponse = await teacherPage.request.get('/api/live-quiz/export');
    expect(summaryResponse.status()).toBe(200);
    const summaryText = await summaryResponse.text();
    expect(summaryText).not.toContain('小明');
    const summary = JSON.parse(summaryText);
    const row = summary.sessions.find((item: any) => item.session_id === sessionId);
    expect(row).toBeTruthy();
    expect(row.state).toBe('ended');
    expect(row.questions).toHaveLength(1);
    expect(row.questions[0].question_key).toBe('q1');
    expect(row.questions[0].answer_count).toBe(1);
    expect(row.questions[0].correct_count).toBe(1);
    expect(row.questions[0].option_counts.one).toBe(1);
    expect(row.questions[0].option_counts.zero || 0).toBe(0);
    expect(row.questions[0].closed_at).toBeTruthy();
  } finally {
    await deleteLesson(teacherPage.request, lessonId, csrf);
    await phone.close();
    await teacher.close();
  }
});

test('two phones answer concurrently; a resend counts once and a changed answer is re-counted', async ({
  browser,
}) => {
  const teacher = await browser.newContext(devices['Desktop Chrome']);
  const teacherPage = await teacher.newPage();
  const phoneA = await browser.newContext(devices['iPhone 13']);
  const phoneB = await browser.newContext(devices['iPhone 13']);
  const studentA = await phoneA.newPage();
  const studentB = await phoneB.newPage();
  await installAnswerResender(studentA);
  // 老師頁面收到的 relay:student-answer 次數：用來確認「重送」真的到了老師手上才去看統計，
  // 否則統計沒變可能只是封包還在路上。
  const teacherFrames = recordReceivedFrames(teacherPage);
  const answersSeen = () => teacherFrames.filter(f => f.includes('relay:student-answer')).length;
  let lessonId: number | null = null;
  let csrf = '';

  try {
    lessonId = await loginAndOpenQuizLesson(teacherPage, 'QR 即時作答 E2E 並發', [choiceQuestion()]);
    csrf = await csrfToken(teacherPage);
    const { sessionId, joinUrl } = await runAndDecodeQr(teacherPage);
    await Promise.all([
      joinStudent(studentA, joinUrl, '小華'),
      joinStudent(studentB, joinUrl, '小美'),
    ]);
    await releaseToBoundLine(teacherPage);
    await expect(studentA.getByRole('heading', { name: 'i 是多少？' })).toBeVisible();
    await expect(studentB.getByRole('heading', { name: 'i 是多少？' })).toBeVisible();
    await expect(teacherPage.getByText('2 位學生已加入').first()).toBeVisible();

    // 兩支手機同時作答：A 選 1（對），B 選 0（錯）
    await studentA.getByLabel('1', { exact: true }).check();
    await studentB.getByLabel('0', { exact: true }).check();
    await Promise.all([
      confirmSubmit(studentA, '送出答案'),
      confirmSubmit(studentB, '送出答案'),
    ]);
    await expect(studentA.getByText('已收到答案，關題前仍可修改。')).toBeVisible();
    await expect(studentB.getByText('已收到答案，關題前仍可修改。')).toBeVisible();
    await expect(teacherPage.getByText('已作答 2', { exact: true })).toBeVisible();
    await expect(teacherPage.getByText('答對 1', { exact: true })).toBeVisible();
    await expect.poll(() => optionCount(teacherPage, '1')).toBe(1);
    await expect.poll(() => optionCount(teacherPage, '0')).toBe(1);

    // 模擬「5 秒沒收到老師回覆」的自動重送：同一份答案，一次原封不動、一次換新 nonce。
    // 重送裡帶的是 A 當初送的答案（1），老師端必須冪等，不能多算一份。
    expect(await studentA.evaluate(() => (window as any).__answerPosts)).toBe(1);
    for (const nonce of [null, 'resend-with-a-fresh-nonce']) {
      const before = answersSeen();
      await studentA.evaluate((value) => (window as any).__resendLastAnswer(value), nonce);
      await expect.poll(answersSeen).toBe(before + 1);
      await expect(teacherPage.getByText('已作答 2', { exact: true })).toBeVisible();
      await expect(teacherPage.getByText('答對 1', { exact: true })).toBeVisible();
      await expect.poll(() => optionCount(teacherPage, '1')).toBe(1);
      await expect.poll(() => optionCount(teacherPage, '0')).toBe(1);
    }

    // 收卷前改答案：A 由 1 改成 0 → 重新計算，不是累加
    await studentA.getByLabel('0', { exact: true }).check();
    await confirmSubmit(studentA, '更新答案');
    await expect(teacherPage.getByText('答對 0', { exact: true })).toBeVisible();
    await expect(teacherPage.getByText('已作答 2', { exact: true })).toBeVisible();
    await expect.poll(() => optionCount(teacherPage, '1')).toBe(0);
    await expect.poll(() => optionCount(teacherPage, '0')).toBe(2);

    await teacherPage.getByRole('button', { name: '結束作答並繼續' }).click();
    await expect(studentA.getByText('✕ 還差一點')).toBeVisible();
    await expect(studentB.getByText('✕ 還差一點')).toBeVisible();

    // 收場上傳的聚合和老師畫面一致：2 份作答、0 份答對、改過的答案只算最後一次
    const endRequest = teacherPage.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/live-quiz/sessions/${sessionId}/end`
    );
    await teacherPage.getByRole('button', { name: '結束課堂' }).click();
    const endResponse = await endRequest;
    expect(endResponse.status()).toBe(200);
    const ended = await endResponse.json();
    expect(ended.questions[0].answer_count).toBe(2);
    expect(ended.questions[0].correct_count).toBe(0);
    expect(ended.questions[0].option_counts.zero).toBe(2);
    expect(ended.questions[0].option_counts.one || 0).toBe(0);
  } finally {
    await deleteLesson(teacherPage.request, lessonId, csrf);
    await phoneA.close();
    await phoneB.close();
    await teacher.close();
  }
});

test('closing the teacher page ends the class for students only after the grace period', async ({
  browser,
}) => {
  const teacher = await browser.newContext(devices['Desktop Chrome']);
  const teacherPage = await teacher.newPage();
  const phone = await browser.newContext(devices['iPhone 13']);
  const studentPage = await phone.newPage();
  let lessonId: number | null = null;
  let csrf = '';

  try {
    lessonId = await loginAndOpenQuizLesson(teacherPage, 'QR 即時作答 E2E 寬限期', [choiceQuestion()]);
    csrf = await csrfToken(teacherPage);
    const { joinUrl } = await runAndDecodeQr(teacherPage);
    await joinStudent(studentPage, joinUrl, '小明');
    await releaseToBoundLine(teacherPage);
    await expect(studentPage.getByRole('heading', { name: 'i 是多少？' })).toBeVisible();

    // 老師分頁關閉 = 課堂結束，但伺服器保留寬限期（docker-compose.test.yml 設成 4 秒）。
    // 寬限期內學生看到的仍然是這堂課，不是「已結束」。
    const closedAt = Date.now();
    await teacherPage.close();
    await expect(studentPage.getByRole('heading', { name: 'i 是多少？' })).toBeVisible();
    await expect(studentPage.getByRole('heading', { name: '課堂已結束' })).toHaveCount(0);
    await expect(studentPage.getByText('本次課堂已結束。')).toHaveCount(0);

    // 寬限期過後：伺服器通知學生並關掉他們的連線。伺服器只開長輪詢（allow_upgrades=False），
    // 分頁一關，伺服器要等 Engine.IO 的 ping 逾時（約 25+20 秒）才知道老師斷線，再加 4 秒寬限。
    await expect(studentPage.getByRole('heading', { name: '課堂已結束' })).toBeVisible({ timeout: 90_000 });
    console.log(`[e2e] student saw the class end ${Date.now() - closedAt} ms after the teacher page closed`);
    await expect(studentPage.getByText('本次課堂已結束。')).toBeVisible();
    await expect(studentPage.getByText('謝謝參與，這個加入連結已失效。')).toBeVisible();
    await expect(studentPage.getByRole('heading', { name: 'i 是多少？' })).toHaveCount(0);
  } finally {
    await deleteLesson(teacher.request, lessonId, csrf);
    await phone.close();
    await teacher.close();
  }
});

test('the grace period holds the class for students after the teacher socket drops, then ends it', async ({
  browser,
}) => {
  // 上一個測試走真實的「關分頁」，但伺服器只開長輪詢，偵測要等 ping 逾時，起點不確定。
  // 這個測試用 installTeacherSocketDropper 讓老師的連線在已知時間點斷掉，驗寬限期的邊界。
  const teacher = await browser.newContext(devices['Desktop Chrome']);
  const teacherPage = await teacher.newPage();
  await installTeacherSocketDropper(teacherPage);
  const phone = await browser.newContext(devices['iPhone 13']);
  const studentPage = await phone.newPage();
  let lessonId: number | null = null;
  let csrf = '';

  try {
    lessonId = await loginAndOpenQuizLesson(teacherPage, 'QR 即時作答 E2E 寬限邊界', [choiceQuestion()]);
    csrf = await csrfToken(teacherPage);
    const { joinUrl } = await runAndDecodeQr(teacherPage);
    await joinStudent(studentPage, joinUrl, '小明');
    await releaseToBoundLine(teacherPage);
    await expect(studentPage.getByRole('heading', { name: 'i 是多少？' })).toBeVisible();

    const droppedAt = Date.now();
    await teacherPage.evaluate(() => (window as any).__dropTeacherSocket());
    await teacherPage.waitForTimeout(1_500);
    // 寬限期（4 秒）內：學生仍看到這堂課，沒有「已結束」
    await expect(studentPage.getByRole('heading', { name: 'i 是多少？' })).toBeVisible();
    await expect(studentPage.getByRole('heading', { name: '課堂已結束' })).toHaveCount(0);

    await expect(studentPage.getByRole('heading', { name: '課堂已結束' })).toBeVisible({ timeout: 20_000 });
    const elapsed = Date.now() - droppedAt;
    console.log(`[e2e] student saw the class end ${elapsed} ms after the teacher socket dropped`);
    expect(elapsed).toBeGreaterThanOrEqual(3_000); // 不是一斷線就結束
    await expect(studentPage.getByText('本次課堂已結束。')).toBeVisible();
  } finally {
    await deleteLesson(teacher.request, lessonId, csrf);
    await phone.close();
    await teacher.close();
  }
});
