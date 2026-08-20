import { readFileSync } from 'fs';
import * as path from 'path';
import { devices, expect, Locator, Page, test } from '@playwright/test';
import { ensureLoggedIn, setupPage } from './helpers';

const SOURCE = readFileSync(
  path.resolve(__dirname, '../../examples/cpp/e2e_containers.cpp'),
  'utf8'
);
const JSQR_SOURCE = readFileSync(require.resolve('jsqr/dist/jsQR.js'), 'utf8');

async function csrfToken(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).initial_data.csrf_token);
}

async function loginAndOpenQuizLesson(page: Page): Promise<number> {
  await setupPage(page);
  await page.addInitScript(() => localStorage.setItem('show_tour_guide', 'false'));
  await ensureLoggedIn(page);
  await page.goto('/edit');
  const created = await page.request.post('/api/lessons', {
    headers: {
      'Content-Type': 'application/json',
      'x-csrftoken': await csrfToken(page),
    },
    data: {
      title: 'QR 即時作答 E2E',
      bundle: {
        version: '2.0',
        fullname_to_render: 'e2e_containers.cpp',
        source_code: SOURCE,
        breakpoints: [{ line: '26', enabled: 'y', is_normal_breakpoint: true }],
        program_input: '',
        quiz: {
          schema_version: 1,
          questions: [
            {
              id: 'q1',
              prompt: 'i 是多少？',
              options: [
                { id: 'zero', text: '0' },
                { id: 'one', text: '1' },
              ],
              correct_option_id: 'one',
              explanation: '程式已執行到指定行。',
              trigger: {
                kind: 'source_line',
                source_file: 'e2e_containers.cpp',
                line: 26,
                anchor: {
                  line_text: 'volatile int x = 0; (void)x;',
                  before_text: ') {',
                  after_text: '}',
                },
              },
            },
          ],
        },
      },
    },
  });
  expect(created.status()).toBe(201);
  const lessonId = (await created.json()).id;
  await page.goto(`/edit?lesson=${lessonId}`);
  await expect(page.getByTestId('live-quiz-open')).toBeVisible({ timeout: 15_000 });
  return lessonId;
}

async function decodeQrPixels(qr: Locator): Promise<string> {
  await qr.waitFor({ state: 'visible' });
  await expect.poll(
    () => qr.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
    { timeout: 10_000 }
  ).toBe(true);
  // Monaco exposes an AMD loader; hide it only inside this wrapper so jsQR installs on window.
  await qr.page().addScriptTag({
    content: `{ const define = undefined, exports = undefined, module = undefined; ${JSQR_SOURCE} }`,
  });
  return qr.evaluate((element: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    context.imageSmoothingEnabled = false;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = (window as any).jsQR(pixels.data, pixels.width, pixels.height);
    if (!result) throw new Error('Rendered QR pixels could not be decoded');
    return result.data;
  });
}

/** 只按 Run：課堂在此建立、QR 彈出，播放刻意停住等老師放行。 */
async function startClassroom(page: Page): Promise<void> {
  await page.click('#run_button');
  await page.getByRole('dialog', { name: '放大的加入 QR Code' })
    .getByRole('button', { name: '關閉' }).click();
  await page.waitForFunction(() => (window as any).store?.get('autoplay_paused') === true);
}

/** 學生掃完之後才放行播放，一路跑到綁定行、題目在那裡開出來。 */
async function resumeToBoundLine(page: Page): Promise<void> {
  await page.click('#autoplay_pause_button');
  await page.waitForFunction(
    () => Number((window as any).store?.get('paused_on_frame')?.line) === 26,
    null,
    { timeout: 30_000 }
  );
}

async function joinStudent(page: Page, url: string, nickname: string): Promise<void> {
  await page.goto(url);
  await page.getByLabel('顯示暱稱').fill(nickname);
  await page.getByRole('button', { name: '加入課堂' }).click();
  await expect(page.getByText('已加入，請等待老師播放到題目。')).toBeVisible();
}

test('student scans rendered QR and answers when playback reaches the bound line', async ({
  browser,
}) => {
  const teacher = await browser.newContext(devices['Desktop Chrome']);
  const teacherPage = await teacher.newPage();
  const phone = await browser.newContext(devices['iPhone 13']);
  const studentPage = await phone.newPage();
  let lessonId: number | null = null;

  try {
    lessonId = await loginAndOpenQuizLesson(teacherPage);
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
    // 「即時課堂」從按鈕改成**預設已勾選**的勾選框，面板一開始就在側欄裡。
    // 這裡不能再點它——點下去是取消勾選，面板反而消失，「開始即時課堂」就找不到了。
    await expect(liveButton).toBeChecked();
    await teacherPage.getByRole('button', { name: '開始即時課堂' }).click();
    await teacherPage.waitForFunction(() =>
      Number(sessionStorage.getItem('gdbgui_live_quiz_session_id')) > 0
    );
    const sessionId = await teacherPage.evaluate(() =>
      Number(sessionStorage.getItem('gdbgui_live_quiz_session_id'))
    );
    expect(sessionId).toBeGreaterThan(0);

    const loaded = await (await teacherPage.request.get(`/api/lessons/${lessonId}`)).json();
    loaded.bundle.source_code = `// v2\n${loaded.bundle.source_code}`;
    loaded.bundle.quiz.questions[0].id = 'q2';
    const updated = await teacherPage.request.put(`/api/lessons/${lessonId}`, {
      headers: {
        'Content-Type': 'application/json',
        'x-csrftoken': await csrfToken(teacherPage),
      },
      data: { title: 'QR 即時作答 E2E v2', bundle: loaded.bundle, parent_version: 1 },
    });
    expect(updated.status()).toBe(200);
    await teacherPage.reload();
    await expect.poll(() => teacherPage.evaluate(() =>
      (window as any).monaco.editor.getModels()[0].getValue()
    )).toBe(SOURCE);
    await expect(teacherPage.getByTestId('save-lesson-to-account')).toBeDisabled();

    // 動線：按 Run 建立課堂並暫停播放 → 學生掃碼 → 老師放行 → 到綁定行才開題。
    // 按 Run 會結束舊課堂並開新的（刻意的行為），所以 Run 之前掃到的 QR 已經失效；
    // 而播放若不暫停，到綁定行時題目就開了，學生根本來不及掃。
    await startClassroom(teacherPage);
    const decodedUrl = await decodeQrPixels(
      teacherPage.locator("img[alt='學生加入課堂的 QR Code']")
    );
    expect(new URL(decodedUrl).pathname).toMatch(/^\/join\/[^/]+$/);
    await expect(teacherPage.getByText('連線主機：app:5000')).toBeVisible();

    await joinStudent(studentPage, decodedUrl, '小明');
    await resumeToBoundLine(teacherPage);
    await expect(studentPage.getByRole('heading', { name: 'i 是多少？' })).toBeVisible();
    for (const id of ['continue_button', 'next_button', 'step_button', 'return_button']) {
      await expect(teacherPage.locator(`#${id}`)).toBeDisabled();
    }
    await studentPage.getByLabel('1', { exact: true }).check();
    await studentPage.getByRole('button', { name: '送出答案' }).click();
    await expect(teacherPage.getByText('答對 1')).toBeVisible();
    await teacherPage.getByRole('button', { name: '結束作答並繼續' }).click();
    await expect(studentPage.getByText('✓ 答對了')).toBeVisible();
    await expect(studentPage.getByText('程式已執行到指定行。')).toBeVisible();
    await expect(teacherPage.locator('#next_button')).toBeEnabled();
    let releaseRestore!: () => void;
    let markRestoreStarted!: () => void;
    const restoreStarted = new Promise<void>(resolve => { markRestoreStarted = resolve; });
    const lessonRoute = `**/api/lessons/${lessonId}`;
    let restoreAttempts = 0;
    await teacherPage.route(lessonRoute, async route => {
      if (route.request().method() === 'GET') {
        markRestoreStarted();
        restoreAttempts += 1;
        if (restoreAttempts === 1) {
          await new Promise<void>(resolve => { releaseRestore = resolve; });
          await route.fulfill({ status: 500, body: '{"error":"temporary"}' });
          return;
        }
      }
      await route.continue();
    });
    await teacherPage.getByRole('button', { name: '結束課堂' }).click();
    await restoreStarted;
    await expect(teacherPage.getByRole('button', { name: '關閉' })).toBeDisabled();
    releaseRestore();
    await expect(teacherPage.getByRole('button', { name: '重試載入' })).toBeVisible();
    await expect(teacherPage.getByRole('button', { name: '關閉' })).toBeDisabled();
    await teacherPage.getByRole('button', { name: '重試載入' }).click();
    await expect.poll(() => teacherPage.evaluate(() =>
      (window as any).monaco.editor.getModels()[0].getValue()
    )).toBe(`// v2\n${SOURCE}`);
    await teacherPage.unroute(lessonRoute);
    await expect(teacherPage.getByTestId('save-lesson-to-account')).toBeEnabled();
    await expect(teacherPage.getByText('本次課堂已結束')).toBeVisible();
    await teacherPage.evaluate(id => {
      sessionStorage.setItem('gdbgui_live_quiz_session_id', String(id));
    }, sessionId);
    await teacherPage.reload();
    await expect(teacherPage.getByText('先前的課堂已結束，可開始新的課堂。')).toBeVisible();
    await expect(teacherPage.getByTestId('save-lesson-to-account')).toBeEnabled();
    await expect.poll(() => teacherPage.evaluate(() =>
      sessionStorage.getItem('gdbgui_live_quiz_session_id')
    )).toBe(null);
    await expect.poll(() => teacherPage.evaluate(() =>
      (window as any).monaco.editor.getModels()[0].getValue()
    )).toBe(`// v2\n${SOURCE}`);
  } finally {
    if (lessonId !== null) {
      await teacherPage.request.delete(`/api/lessons/${lessonId}`, {
        headers: { 'x-csrftoken': await csrfToken(teacherPage) },
      });
    }
    await phone.close();
    await teacher.close();
  }
});

test('two phones submit concurrently and a retry cannot replace the first answer', async ({
  browser,
}) => {
  const teacher = await browser.newContext(devices['Desktop Chrome']);
  const teacherPage = await teacher.newPage();
  const phoneA = await browser.newContext(devices['iPhone 13']);
  const phoneB = await browser.newContext(devices['iPhone 13']);
  const studentA = await phoneA.newPage();
  const studentB = await phoneB.newPage();
  let lessonId: number | null = null;

  try {
    lessonId = await loginAndOpenQuizLesson(teacherPage);
    // 勾選框預設已勾選，面板已在側欄；點它是取消勾選（見上一條測試的註解）。
    await expect(teacherPage.getByTestId('live-quiz-open')).toBeChecked();
    await teacherPage.getByRole('button', { name: '開始即時課堂' }).click();
    // 動線：按 Run 建立課堂並暫停播放 → 學生掃碼 → 老師放行 → 到綁定行才開題。
    // 按 Run 會結束舊課堂並開新的（刻意的行為），所以 Run 之前掃到的 QR 已經失效；
    // 而播放若不暫停，到綁定行時題目就開了，學生根本來不及掃。
    await startClassroom(teacherPage);
    const decodedUrl = await decodeQrPixels(
      teacherPage.locator("img[alt='學生加入課堂的 QR Code']")
    );
    await Promise.all([
      joinStudent(studentA, decodedUrl, '小華'),
      joinStudent(studentB, decodedUrl, '小美'),
    ]);
    await resumeToBoundLine(teacherPage);

    const [answerA, answerB] = await Promise.all([
      studentA.request.post('/api/live-quiz/guest/answers', {
        data: { question_id: 'q1', option_id: 'one' },
      }),
      studentB.request.post('/api/live-quiz/guest/answers', {
        data: { question_id: 'q1', option_id: 'zero' },
      }),
    ]);
    expect(answerA.status()).toBe(200);
    expect(answerB.status()).toBe(200);

    const retried = await studentA.request.post('/api/live-quiz/guest/answers', {
      data: { question_id: 'q1', option_id: 'zero' },
    });
    expect(retried.status()).toBe(200);
    expect((await retried.json()).active_question.selected_option_id).toBe('one');
    await expect(teacherPage.getByText('已作答 2', { exact: true })).toBeVisible();
    await expect(teacherPage.getByText('答對 1', { exact: true })).toBeVisible();
  } finally {
    if (lessonId !== null) {
      await teacherPage.request.delete(`/api/lessons/${lessonId}`, {
        headers: { 'x-csrftoken': await csrfToken(teacherPage) },
      });
    }
    await phoneA.close();
    await phoneB.close();
    await teacher.close();
  }
});
