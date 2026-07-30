/**
 * 教案分享（子專案 C）的前端路徑。
 *
 * 後端的授權由 tests/test_lesson_sharing.py 覆蓋；這裡只驗前端真的接得上：
 * 「存到我的帳號」把編輯器內容存進伺服器，`/?lesson=<id>` 把它讀回編輯器，
 * 以及「開啟別人的教案 → 儲存 → 變成自己的副本」在瀏覽器裡真的是那個行為。
 */
import { test, expect, Page } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

async function csrfToken(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).initial_data.csrf_token);
}

async function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const monaco = (window as any).monaco;
    const models = monaco.editor.getModels();
    return models.length ? models[0].getValue() : '';
  });
}

test('save to my account, then reopen it from the library link', async ({ page }) => {
  await ensureLoggedIn(page);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).monaco?.editor?.getModels()?.length > 0);

  const marker = `// lesson-e2e-${Date.now()}`;
  await page.evaluate((text) => {
    const model = (window as any).monaco.editor.getModels()[0];
    model.setValue(text + '\nint main() { return 0; }\n');
  }, marker);

  // 「存到我的帳號」用 window.prompt 問標題
  const title = `E2E 教案 ${Date.now()}`;
  page.once('dialog', (dialog) => dialog.accept(title));
  await page.getByTestId('save-lesson-to-account').click();

  // 存好之後它會出現在教案庫頁
  await expect
    .poll(async () => (await page.request.get('/lessons')).text().then((t) => t.includes(title)), {
      timeout: 10_000,
    })
    .toBe(true);

  // 教案庫頁：標題連到 /?lesson=<id>
  await page.goto('/lessons');
  const link = page.getByTestId('lesson-library-title').filter({ hasText: title }).first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/\/\?lesson=\d+$/);

  // 開啟它 → 編輯器裡是剛剛存的內容
  await page.goto(href!);
  await page.waitForFunction(() => (window as any).monaco?.editor?.getModels()?.length > 0);
  await expect.poll(async () => (await editorText(page)).includes(marker), { timeout: 15_000 }).toBe(
    true
  );

  // 收乾淨：刪掉它，兩個列表都不該再有
  const id = Number(href!.match(/lesson=(\d+)/)![1]);
  const token = await csrfToken(page);
  const deleted = await page.request.delete(`/api/lessons/${id}`, {
    headers: { 'x-csrftoken': token },
  });
  expect(deleted.status()).toBe(200);
  expect(await (await page.request.get('/lessons')).text()).not.toContain(title);
});

test('opening someone else\'s lesson and saving makes a copy, leaving the original alone', async ({
  page,
  browser,
}) => {
  // 作者：另一個瀏覽器 context = 另一個帳號
  const authorContext = await browser.newContext();
  const authorPage = await authorContext.newPage();
  await ensureLoggedIn(authorPage);
  await authorPage.goto('/');
  await authorPage.waitForFunction(
    () => (window as any).monaco?.editor?.getModels()?.length > 0
  );

  const authorTitle = `作者的教案 ${Date.now()}`;
  const authorToken = await csrfToken(authorPage);
  const created = await authorPage.request.post('/api/lessons', {
    headers: { 'x-csrftoken': authorToken, 'Content-Type': 'application/json' },
    data: {
      title: authorTitle,
      bundle: {
        version: '2.0',
        fullname_to_render: 'main.cpp',
        source_code: '// AUTHOR ORIGINAL\nint main() { return 0; }\n',
        breakpoints: [],
        program_input: '',
      },
    },
  });
  expect(created.status()).toBe(201);
  const lessonId = (await created.json()).id;

  // 讀者：開作者的教案、改一行、按儲存
  await ensureLoggedIn(page);
  await page.goto(`/?lesson=${lessonId}`);
  await page.waitForFunction(() => (window as any).monaco?.editor?.getModels()?.length > 0);
  await expect
    .poll(async () => (await editorText(page)).includes('AUTHOR ORIGINAL'), { timeout: 15_000 })
    .toBe(true);

  await page.evaluate(() => {
    const model = (window as any).monaco.editor.getModels()[0];
    model.setValue('// READER EDIT\nint main() { return 0; }\n');
  });
  const readerTitle = `讀者的版本 ${Date.now()}`;
  page.once('dialog', (dialog) => dialog.accept(readerTitle));
  await page.getByTestId('save-lesson-to-account').click();

  // 讀者名下多了一份副本…
  await expect
    .poll(
      async () => (await (await page.request.get('/lessons')).text()).includes(readerTitle),
      { timeout: 10_000 }
    )
    .toBe(true);

  // …而作者的原件一個字都沒變。
  const original = await authorPage.request.get(`/api/lessons/${lessonId}`);
  const originalBody = await original.json();
  expect(originalBody.title).toBe(authorTitle);
  expect(originalBody.bundle.source_code).toContain('AUTHOR ORIGINAL');
  expect(originalBody.bundle.source_code).not.toContain('READER EDIT');

  // 讀者刪不掉作者的
  const refused = await page.request.delete(`/api/lessons/${lessonId}`, {
    headers: { 'x-csrftoken': await csrfToken(page) },
  });
  expect(refused.status()).toBe(404);
  expect((await (await authorPage.request.get(`/api/lessons/${lessonId}`)).json()).title).toBe(
    authorTitle
  );

  await authorPage.request.delete(`/api/lessons/${lessonId}`, {
    headers: { 'x-csrftoken': authorToken },
  });
  await authorContext.close();
});
