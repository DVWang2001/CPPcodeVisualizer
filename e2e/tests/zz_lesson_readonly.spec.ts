/**
 * 別人的教案是唯讀的：不能改指導註解，也不能改課堂題目。
 *
 * 這條規則在伺服器端本來就成立（live_quiz.create_session 要求 l.user_id 相符，
 * 教案儲存對非作者是 fork），這支守的是前端不要提供無效的編輯入口——以前
 * 「課堂題目」對別人的教案照樣可以打字，改完卻無處可去。
 */
import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import * as path from 'path';

const BUNDLE = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../examples/cpp/c_live_quiz.gdbgui.json'), 'utf8')
);

async function register(page: Page, prefix: string): Promise<void> {
  const username = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/register');
  await page.fill('#username', username);
  await page.fill('#display_name', 'RO');
  await page.fill('#password', 'readonly-test-1234');
  await Promise.all([page.waitForURL(/\/(edit|u\/)/), page.click('#submit')]);
}

async function openEditor(page: Page, url: string): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('show_tour_guide', 'false'));
  await page.goto(url);
  await page.waitForFunction(
    () => (window as any).monaco?.editor?.getModels()?.length > 0,
    null,
    { timeout: 60_000 }
  );
  await page.waitForTimeout(2500);
}

/** 作者建立一篇帶課堂題目的教案，回傳 id。 */
async function seedLesson(page: Page): Promise<number> {
  await register(page, 'ro');
  await openEditor(page, '/edit');
  const token = await page.evaluate(() => (window as any).initial_data.csrf_token);
  const created = await page.request.post('/api/lessons', {
    headers: { 'x-csrftoken': token, 'Content-Type': 'application/json' },
    data: { title: `唯讀測試 ${Date.now()}`, bundle: BUNDLE },
  });
  expect(created.status()).toBe(201);
  return (await created.json()).id;
}

test('作者可以編輯自己的教案題目', async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const id = await seedLesson(page);

  await openEditor(page, `/edit?lesson=${id}`);
  await page.getByTestId('quiz-authoring-open').click();
  await expect(page.getByTestId('quiz-authoring-dialog')).toBeVisible();

  await expect(page.getByTestId('quiz-authoring-readonly-notice')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '儲存題目' })).toBeVisible();
  await expect(page.getByRole('button', { name: /新增題目/ })).toBeVisible();
  await context.close();
});

test('別人的教案：題目只能看，指導註解不提供編輯入口', async ({ browser }) => {
  test.setTimeout(180_000);

  const owner = await browser.newContext();
  const ownerPage = await owner.newPage();
  const id = await seedLesson(ownerPage);
  await owner.close();

  const reader = await browser.newContext();
  const page = await reader.newPage();
  await register(page, 'rd');
  await openEditor(page, `/edit?lesson=${id}`);

  // 題目：看得到，但改不了
  await page.getByTestId('quiz-authoring-open').click();
  const dialog = page.getByTestId('quiz-authoring-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('quiz-authoring-readonly-notice')).toBeVisible();
  await expect(page.getByRole('button', { name: '儲存題目' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /新增題目/ })).toHaveCount(0);

  // 題幹確實顯示出來了（唯讀不等於藏起來），而且每個輸入框都被停用
  const inputs = dialog.locator('input, textarea');
  const n = await inputs.count();
  expect(n, '題目欄位應該有被渲染出來').toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    await expect(inputs.nth(i)).toBeDisabled();
  }

  await page.keyboard.press('Escape');

  // 指導註解：✎ 編輯入口不出現。
  // 用 toBeHidden 而不是 toHaveCount(0)：Monaco 的 content widget DOM 節點是
  // 常駐的，重點是它不能被看到、不能被點。
  await page.mouse.move(400, 300);
  await page.waitForTimeout(800);
  await expect(page.locator('.gdbgui-annot-edit-glyph')).toBeHidden();
  await reader.close();
});

test('存到我的帳號會複製一份，並且看得出來已經換到自己的副本上', async ({ browser }) => {
  test.setTimeout(180_000);

  const owner = await browser.newContext();
  const ownerPage = await owner.newPage();
  const id = await seedLesson(ownerPage);
  await owner.close();

  const reader = await browser.newContext();
  const page = await reader.newPage();

  const alerts: string[] = [];
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt') return d.accept('我的副本');
    alerts.push(d.message());
    await d.dismiss();
  });

  await register(page, 'fk');
  await openEditor(page, `/edit?lesson=${id}`);

  // 別人的教案：即時課堂按鈕不在
  await expect(page.getByTestId('live-quiz-open')).toHaveCount(0);

  await page.getByTestId('save-lesson-to-account').click();
  await page.waitForTimeout(4000);

  // fork 之後：按鈕解鎖、網址換成新的那一篇、而且有講清楚發生了什麼事
  await expect(page.getByTestId('live-quiz-open')).toBeVisible();
  expect(alerts.join('\n'), 'fork 必須明確告知，不能只寫進可能收合的 console').toMatch(
    /另存一份/
  );
  const lessonParam = new URL(page.url()).searchParams.get('lesson');
  expect(lessonParam, '網址要指向自己的副本，而不是原作者那篇').not.toBe(String(id));
  expect(Number(lessonParam)).toBeGreaterThan(0);

  // 換到自己的副本之後，指導註解的 ✎ 也回來了
  await page.mouse.move(400, 300);
  await page.waitForTimeout(800);
  await expect(page.locator('.gdbgui-annot-edit-glyph')).toBeVisible();
  await reader.close();
});
