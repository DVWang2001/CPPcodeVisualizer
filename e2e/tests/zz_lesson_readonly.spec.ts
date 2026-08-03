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

async function register(page: Page, prefix: string): Promise<string> {
  const username = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/register');
  await page.fill('#username', username);
  await page.fill('#display_name', 'RO');
  await page.fill('#password', 'readonly-test-1234');
  await Promise.all([page.waitForURL(/\/(edit|u\/)/), page.click('#submit')]);
  return username;
}

/**
 * 這些測試跑在正式站上，所以自己收拾：把留下的教案刪掉。
 *
 * 不導覽——page.request 共用 cookie，從任何頁面都送得出去。以前這裡先
 * goto('/edit') 拿 token，結果被編輯器的 beforeunload 攔成 ERR_ABORTED，
 * 清理反而失敗、垃圾照樣留下。token 改由呼叫端在編輯器裡先取好。
 */
async function cleanup(page: Page, token: string, ids: number[]): Promise<void> {
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) continue;
    await page.request.delete(`/api/lessons/${id}`, { headers: { 'x-csrftoken': token } });
  }
}

/**
 * 編輯器頁面無條件掛了 onbeforeunload（GlobalEvents.ts），離開 /edit 一定會跳
 * 確認框。不 accept 的話瀏覽器會取消導覽（ERR_ABORTED）。
 *
 * 存檔流程本身已經不用瀏覽器對話框了（改成頁面內的 LessonSaveDialog），
 * 這裡只剩 beforeunload 要處理。
 */
function handleDialogs(page: Page): void {
  page.on('dialog', async (d) => {
    if (d.type() === 'beforeunload') return d.accept();
    await d.dismiss();
  });
}

/** 走頁面內的存檔對話框：填標題、按儲存。 */
async function saveAs(page: Page, title: string): Promise<void> {
  await page.getByTestId('save-lesson-to-account').click();
  await expect(page.getByTestId('lesson-save-dialog')).toBeVisible();
  await page.getByTestId('lesson-save-title-input').fill(title);
  await page.getByTestId('lesson-save-confirm').click();
  await expect(page.getByTestId('lesson-save-notice')).toBeVisible({ timeout: 20_000 });
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

  const forkTitle = `副本測試 ${Date.now()}`;
  handleDialogs(page);

  await register(page, 'fk');
  await openEditor(page, `/edit?lesson=${id}`);
  const token = await page.evaluate(() => (window as any).initial_data.csrf_token);

  // 別人的教案：即時課堂按鈕不在
  await expect(page.getByTestId('live-quiz-open')).toHaveCount(0);

  await saveAs(page, forkTitle);

  // fork 之後：按鈕解鎖、網址換成新的那一篇、而且有講清楚發生了什麼事
  await expect(page.getByTestId('live-quiz-open')).toBeVisible();
  await expect(
    page.getByTestId('lesson-save-notice'),
    'fork 必須在頁面內明確告知，不能只寫進可能收合的 console'
  ).toContainText('另存一份');
  const lessonParam = new URL(page.url()).searchParams.get('lesson');
  expect(lessonParam, '網址要指向自己的副本，而不是原作者那篇').not.toBe(String(id));
  expect(Number(lessonParam)).toBeGreaterThan(0);

  // 換到自己的副本之後，指導註解的 ✎ 也回來了
  await page.mouse.move(400, 300);
  await page.waitForTimeout(800);
  await expect(page.locator('.gdbgui-annot-edit-glyph')).toBeVisible();

  await cleanup(page, token, [Number(lessonParam)]);
  await reader.close();
});

test('存到我的帳號之後，教案要出現在自己的個人檔案頁', async ({ browser }) => {
  test.setTimeout(180_000);

  const owner = await browser.newContext();
  const ownerPage = await owner.newPage();
  const originalId = await seedLesson(ownerPage);
  await owner.close();

  const reader = await browser.newContext();
  const page = await reader.newPage();
  // 標題帶時間戳：跑在正式站上，固定字串會和先前留下的同名教案撞在一起，
  // 讓斷言變成 strict mode violation。
  const forkTitle = `個人檔案可見性測試 ${Date.now()}`;
  handleDialogs(page);

  const username = await register(page, 'pf');

  // 存之前：個人檔案頁應該是空的
  await page.goto(`/u/${username}`);
  await expect(page.getByTestId('profile-lesson')).toHaveCount(0);

  await openEditor(page, `/edit?lesson=${originalId}`);
  const token = await page.evaluate(() => (window as any).initial_data.csrf_token);
  await saveAs(page, forkTitle);

  const forkedId = Number(new URL(page.url()).searchParams.get('lesson'));
  expect(forkedId, 'fork 應該產生一個新的教案 id').not.toBe(originalId);

  // 存之後：個人檔案頁要看得到它，而且連結指向那份副本
  await page.goto(`/u/${username}`, { waitUntil: 'domcontentloaded' });
  const rows = page.getByTestId('profile-lesson');
  await expect(rows, '存到我的帳號之後，個人檔案頁必須看得到這篇教案').toHaveCount(1);
  await expect(rows.first()).toContainText(forkTitle);
  await expect(rows.first().locator('a.row-title')).toHaveAttribute(
    'href',
    new RegExp(`lesson=${forkedId}\\b`)
  );

  // 教案庫也要找得到。用搜尋而不是直接看首頁第一頁：首頁有分頁，
  // 站上教案一多，新的那篇不保證落在第一頁。
  await page.goto(`/?q=${encodeURIComponent(forkTitle)}`);
  await expect(
    page.getByTestId('lesson-browse-title').filter({ hasText: forkTitle })
  ).toBeVisible();

  await cleanup(page, token, [forkedId]);
  await reader.close();
});
