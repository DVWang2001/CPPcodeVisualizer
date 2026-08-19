import { readFileSync } from 'fs';
import * as path from 'path';
import { devices, expect, Page, test } from '@playwright/test';
import { ensureLoggedIn, setupGuide, setupPage } from './helpers';

const SOURCE = readFileSync(
  path.resolve(__dirname, '../../examples/cpp/e2e_containers.cpp'),
  'utf8'
);

async function csrfToken(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).initial_data.csrf_token);
}

async function createLesson(page: Page): Promise<number> {
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
      title: 'DP 填表 E2E',
      bundle: {
        version: '2.0',
        fullname_to_render: 'e2e_containers.cpp',
        source_code: SOURCE,
        breakpoints: [{ line: '26', enabled: 'y', is_normal_breakpoint: true }],
        program_input: '',
        quiz: {
          schema_version: 1,
          questions: [{
            id: 'dp-table',
            kind: 'table',
            prompt: '填出 dp 的內容',
            explanation: '兩列兩欄的動態規劃表。',
            table_spec: { var_hint: 'dp', max_cells: 4 },
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
          }],
        },
      },
    },
  });
  expect(created.status()).toBe(201);
  return (await created.json()).id;
}

async function join(page: Page, url: string, nickname: string): Promise<void> {
  await page.goto(url);
  await page.getByLabel('顯示暱稱').fill(nickname);
  await page.getByRole('button', { name: '加入課堂' }).click();
  await expect(page.getByText('已加入，請等待老師播放到題目。')).toBeVisible();
}

async function fillTable(page: Page, values: string[][]): Promise<void> {
  for (let row = 0; row < values.length; row += 1) {
    for (let col = 0; col < values[row].length; col += 1) {
      const input = page.getByLabel(`${row}，${col}`, { exact: true });
      await input.focus();
      await page.keyboard.insertText(values[row][col]);
      await expect(input).toHaveValue(values[row][col]);
    }
  }
  await page.getByRole('button', { name: '送出答案' }).click();
  await expect(page.getByText('已收到答案，請等待老師關題。')).toBeVisible();
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
  let lessonId: number | null = null;

  try {
    lessonId = await createLesson(teacherPage);
    await teacherPage.goto(`/edit?lesson=${lessonId}`);
    await expect(teacherPage.getByTestId('live-quiz-open')).toBeVisible({ timeout: 15_000 });
    await setupGuide(teacherPage, '{dp}');
    await teacherPage.click('#run_button');
    await teacherPage.waitForFunction(() =>
      Number(sessionStorage.getItem('gdbgui_live_quiz_session_id')) > 0
    );
    await teacherPage.waitForFunction(
      () => Number((window as any).store?.get('paused_on_frame')?.line) === 26,
      null,
      { timeout: 30_000 }
    );
    const sessionId = await teacherPage.evaluate(() =>
      Number(sessionStorage.getItem('gdbgui_live_quiz_session_id'))
    );
    const session = await (await teacherPage.request.get(`/api/live-quiz/sessions/${sessionId}`)).json();
    await teacherPage.getByRole('dialog', { name: '放大的加入 QR Code' })
      .getByRole('button', { name: '關閉' }).click();
    await Promise.all([
      join(studentA, session.join_url, '手機甲'),
      join(studentB, session.join_url, '手機乙'),
    ]);

    const selector = teacherPage.getByLabel('正解容器');
    await expect(selector).toHaveValue('dp', { timeout: 20_000 });
    const confirmation = teacherPage.getByRole('button', { name: '確認出題' }).locator('..');
    await expect.poll(() => confirmation.locator('td').allTextContents()).toEqual(['11', '22', '33', '44']);
    await teacherPage.getByRole('button', { name: '確認出題' }).click();
    await expect(studentA.getByRole('heading', { name: '填出 dp 的內容' })).toBeVisible();
    await expect(studentB.getByRole('heading', { name: '填出 dp 的內容' })).toBeVisible();

    for (const student of [studentA, studentB]) {
      const response = await student.request.get('/api/live-quiz/guest/state');
      expect(response.status()).toBe(200);
      const openState = await response.json();
      expect(openState.active_question.answer).toBeNull();
      expect(openState.active_question).not.toHaveProperty('correct_values');
      const raw = JSON.stringify(openState);
      for (const value of ['11', '22', '33', '44']) expect(raw).not.toContain(`"${value}"`);
    }

    await Promise.all([
      fillTable(studentA, [['11', '22'], ['33', '44']]),
      fillTable(studentB, [['11', '999'], ['888', '44']]),
    ]);
    await teacherPage.getByRole('button', { name: '結束作答並繼續' }).click();

    for (const [row, col, wrong] of [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]]) {
      await expect(teacherPage.getByLabel(`${row}，${col}：2 人中有 ${wrong} 人答錯`)).toBeVisible();
    }
    await expect(studentA.getByText('4/4 格正確')).toBeVisible();
    await expect(studentB.getByText('2/4 格正確')).toBeVisible();
    await expect(studentB.getByLabel('0，1，答案錯誤，正確答案 22')).toBeVisible();
    await expect(studentB.getByLabel('1，0，答案錯誤，正確答案 33')).toBeVisible();
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
