import { devices, expect, Page, test } from '@playwright/test';
import { setupGuide } from './helpers';
import {
  confirmSubmit,
  csrfToken,
  deleteLesson,
  joinStudent,
  loginAndOpenQuizLesson,
  recordReceivedFrames,
  releaseToBoundLine,
  runAndDecodeQr,
  tableQuestion,
} from './live_quiz_helpers';

test.setTimeout(240_000);

async function fillTable(page: Page, values: string[][]): Promise<void> {
  for (let row = 0; row < values.length; row += 1) {
    for (let col = 0; col < values[row].length; col += 1) {
      const input = page.getByLabel(`${row}，${col}`, { exact: true });
      await input.focus();
      await page.keyboard.insertText(values[row][col]);
      await expect(input).toHaveValue(values[row][col]);
    }
  }
  // 兩步送出：送出答案 → 確認送出；「已收到」要等老師端確認才會出現
  await confirmSubmit(page, '送出答案');
  await expect(page.getByText('已收到答案，關題前仍可修改。')).toBeVisible();
  for (let row = 0; row < values.length; row += 1) {
    for (let col = 0; col < values[row].length; col += 1) {
      await expect(page.getByLabel(`${row}，${col}`, { exact: true })).toHaveValue(values[row][col]);
    }
  }
}

test('two phones answer a captured DP table without leaking it before close', async ({ browser }) => {
  const teacher = await browser.newContext(devices['Desktop Chrome']);
  const teacherPage = await teacher.newPage();
  const android14 = {
    viewport: { width: 360, height: 820 },
    screen: { width: 720, height: 1640 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  };
  const phoneA = await browser.newContext(android14);
  const phoneB = await browser.newContext(android14);
  const studentA = await phoneA.newPage();
  const studentB = await phoneB.newPage();
  const framesA = recordReceivedFrames(studentA);
  const framesB = recordReceivedFrames(studentB);
  let lessonId: number | null = null;
  let csrf = '';

  try {
    lessonId = await loginAndOpenQuizLesson(teacherPage, 'DP 填表 E2E', [tableQuestion()]);
    csrf = await csrfToken(teacherPage);
    await setupGuide(teacherPage, '{dp}');

    // 按 Run 開課並彈出 QR；學生從 QR 像素解出的網址加入，之後老師關 QR 放行播放。
    const { sessionId, joinUrl } = await runAndDecodeQr(teacherPage);
    await Promise.all([
      joinStudent(studentA, joinUrl, '手機甲'),
      joinStudent(studentB, joinUrl, '手機乙'),
    ]);
    await releaseToBoundLine(teacherPage);

    // 老師在綁定行擷取當下的 dp 表格，確認後才出題
    // 容器下拉選單沒有 aria-label（早先的「正解容器」標籤已不在畫面上），用確認彈窗的 testid 定位。
    const selector = teacherPage.getByTestId('table-trigger-confirm-overlay').locator('select');
    await expect(selector).toHaveValue('dp', { timeout: 20_000 });
    const confirmation = teacherPage.getByRole('button', { name: '確認出題' }).locator('..');
    await expect.poll(() => confirmation.locator('td').allTextContents()).toEqual(['11', '22', '33', '44']);
    await teacherPage.getByRole('button', { name: '確認出題' }).click();
    await expect(studentA.getByRole('heading', { name: '填出 dp 的內容' })).toBeVisible();
    await expect(studentB.getByRole('heading', { name: '填出 dp 的內容' })).toBeVisible();

    // 收卷前學生端不得有正解：看學生實際收到的每一個 socket 框架（取代已移除的
    // GET /api/live-quiz/guest/state），以及畫面本身。
    for (const [student, frames] of [[studentA, framesA], [studentB, framesB]] as const) {
      await expect.poll(() => frames.join('\n')).toContain('填出 dp 的內容'); // 確認真的有看到題目那個框架
      const received = frames.join('\n');
      expect(received).not.toContain('correct_values');
      expect(received).not.toContain('兩列兩欄的動態規劃表。');
      for (const value of ['11', '22', '33', '44']) expect(received).not.toContain(`"${value}"`);
      await expect(student.locator('.result-box')).toHaveCount(0);
      expect(await student.content()).not.toContain('兩列兩欄的動態規劃表。');
    }

    await Promise.all([
      fillTable(studentA, [['11', '22'], ['33', '44']]),
      fillTable(studentB, [['11', '999'], ['888', '44']]),
    ]);
    await expect(teacherPage.getByText('已作答 2', { exact: true })).toBeVisible();
    // 收卷前老師也不看個別作答：其他人還在寫（取代已移除的 responses 路由的 409）
    await expect(teacherPage.getByTestId('live-quiz-review-item')).toHaveCount(0);
    await expect(teacherPage.getByText('個別作答（')).toHaveCount(0);
    await expect(teacherPage.getByText('正確答案', { exact: true })).toHaveCount(0);

    await teacherPage.getByRole('button', { name: '結束作答並繼續' }).click();

    for (const [row, col, wrong] of [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]]) {
      await expect(teacherPage.getByLabel(`${row}，${col}：2 人中有 ${wrong} 人答錯`)).toBeVisible();
    }
    await expect(studentA.getByText('4/4 格正確')).toBeVisible();
    await expect(studentB.getByText('2/4 格正確')).toBeVisible();
    await expect(studentB.getByLabel('0，1，答案錯誤，正確答案 22')).toBeVisible();
    await expect(studentB.getByLabel('1，0，答案錯誤，正確答案 33')).toBeVisible();
    // 收卷後才給解說
    await expect(studentA.getByText('兩列兩欄的動態規劃表。')).toBeVisible();

    // 收卷後的個別作答檢討：答對最少的排最前，教師要檢討的就是那一份。
    const reviewItems = teacherPage.getByTestId('live-quiz-review-item');
    await expect(reviewItems).toHaveCount(2, { timeout: 15_000 });
    await expect(reviewItems.first()).toContainText('手機乙');
    await expect(reviewItems.first()).toContainText('2/4');
    await expect(reviewItems.nth(1)).toContainText('手機甲');
    await expect(reviewItems.nth(1)).toContainText('4/4');

    // 展開那一份，錯的兩格帶著正解
    await reviewItems.first().click();
    await expect(teacherPage.getByTitle('正解 22')).toBeVisible();
    await expect(teacherPage.getByTitle('正解 33')).toBeVisible();

    // 收場：上傳的是匿名的逐格答錯次數（熱區圖的資料），不含暱稱與作答內容。
    const endRequest = teacherPage.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/live-quiz/sessions/${sessionId}/end`
    );
    await teacherPage.getByRole('button', { name: '結束課堂' }).click();
    const endResponse = await endRequest;
    expect(endResponse.status()).toBe(200);
    const summaryResponse = await teacherPage.request.get('/api/live-quiz/export');
    expect(summaryResponse.status()).toBe(200);
    const summaryText = await summaryResponse.text();
    for (const secret of ['手機甲', '手機乙', '999', '888']) expect(summaryText).not.toContain(secret);
    const row = JSON.parse(summaryText).sessions.find((item: any) => item.session_id === sessionId);
    expect(row).toBeTruthy();
    expect(row.questions[0].kind).toBe('table');
    expect(row.questions[0].answer_count).toBe(2);
    expect(row.questions[0].cell_stats).toEqual([0, 1, 1, 0]);
  } finally {
    await deleteLesson(teacherPage.request, lessonId, csrf);
    await phoneA.close();
    await phoneB.close();
    await teacher.close();
  }
});
