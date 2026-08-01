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
        breakpoints: [],
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

async function runTeacherToBoundLine(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).gdbgui_get_editor_value = () => '';
    (window as any).gdbgui_get_editor_filename = () => null;
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith('gdbgui_editor_code_')) localStorage.removeItem(key);
    }
  });
  await page.click('#run_button');
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
    await liveButton.click();
    await teacherPage.getByRole('button', { name: '開始即時課堂' }).click();

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

    const decodedUrl = await decodeQrPixels(
      teacherPage.locator("img[alt='學生加入課堂的 QR Code']")
    );
    expect(new URL(decodedUrl).pathname).toMatch(/^\/join\/[^/]+$/);
    await expect(teacherPage.getByText('連線主機：app:5000')).toBeVisible();
    await expect(teacherPage.getByText('請用一支非教師手機測試')).toBeVisible();

    await joinStudent(studentPage, decodedUrl, '小明');
    await runTeacherToBoundLine(teacherPage);
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
    await teacherPage.getByTestId('live-quiz-open').click();
    await teacherPage.getByRole('button', { name: '開始即時課堂' }).click();
    const decodedUrl = await decodeQrPixels(
      teacherPage.locator("img[alt='學生加入課堂的 QR Code']")
    );
    await Promise.all([
      joinStudent(studentA, decodedUrl, '小華'),
      joinStudent(studentB, decodedUrl, '小美'),
    ]);
    await runTeacherToBoundLine(teacherPage);

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
