/**
 * 標籤與瀏覽。後端授權由 tests/test_tags_api.py 覆蓋；這裡只驗前端接得上：
 * 在個人檔案頁貼標籤 → 主頁搜尋得到 → 點標籤能縮小清單。
 *
 * 教案用 examples/cpp/rec_sum.gdbgui.json（真的線性遞迴教案，含 //@ 註解與
 * 斷點），不是 `int main(){}`：這樣留在站上的教案打得開、也真的在測會被使用者
 * 存起來的那種 bundle 形狀。
 */
import { test, expect, Page } from '@playwright/test';
import { ensureLoggedIn, realLessonBundle } from './helpers';

const LESSON = realLessonBundle('rec_sum');

async function csrfToken(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).initial_data.csrf_token);
}

async function createLesson(page: Page, token: string, title: string): Promise<number> {
  const created = await page.request.post('/api/lessons', {
    headers: { 'x-csrftoken': token, 'Content-Type': 'application/json' },
    data: { title, bundle: LESSON },
  });
  expect(created.status()).toBe(201);
  return (await created.json()).id;
}

test('tag a lesson, then find it by搜尋 and by clicking the tag', async ({ page }) => {
  await ensureLoggedIn(page);
  await page.goto('/edit');
  await page.waitForFunction(() => (window as any).monaco?.editor?.getModels()?.length > 0);
  const token = await csrfToken(page);

  const stamp = Date.now();
  const title = `標籤測試 ${stamp}`;
  const tag = `e2etag${stamp}`;

  const id = await createLesson(page, token, title);

  const tagged = await page.request.post(`/api/lessons/${id}/tags`, {
    headers: { 'x-csrftoken': token, 'Content-Type': 'application/json' },
    data: { tags: `${tag}, STL` },
  });
  expect(tagged.status()).toBe(200);
  expect((await tagged.json()).tags).toContain(tag);

  // 搜尋標籤名找得到這篇
  await page.goto(`/?q=${encodeURIComponent(tag)}`);
  await expect(page.getByTestId('lesson-browse-title').filter({ hasText: title })).toBeVisible();

  // 點列上的標籤 → 網址帶上 tag，清單仍然有這篇
  await page.getByTestId('lesson-browse-tag').filter({ hasText: tag }).first().click();
  await expect(page).toHaveURL(new RegExp(`tag=${tag}`));
  await expect(page.getByTestId('lesson-browse-title').filter({ hasText: title })).toBeVisible();

  // 收乾淨。刪不掉就讓測試紅：靜默的清理失敗會把垃圾教案留在站上。
  const removed = await page.request.delete(`/api/lessons/${id}`, {
    headers: { 'x-csrftoken': token },
  });
  expect(removed.ok()).toBe(true);
});

test('the tag editor on your own profile writes tags', async ({ page }) => {
  await ensureLoggedIn(page);
  await page.goto('/edit');
  await page.waitForFunction(() => (window as any).monaco?.editor?.getModels()?.length > 0);
  const token = await csrfToken(page);

  const stamp = Date.now();
  const tag = `profiletag${stamp}`;
  const id = await createLesson(page, token, `編輯器測試 ${stamp}`);

  await page.goto('/');
  await page.getByTestId('lesson-browse-author').first().click();

  // 定位到剛建立的那一篇，不是 .first()：.first() 會在別的教案上打標籤，
  // 而這條測試照樣綠。
  const row = page.locator(`li.row:has([data-testid="profile-tag-input"][data-lesson-id="${id}"])`);
  await expect(row).toHaveCount(1);
  await row.getByTestId('profile-tag-input').fill(tag);
  await row.getByTestId('profile-tag-save').click();
  await expect(row.locator('.status')).toHaveText('已儲存');

  // 「已儲存」只是 UI 文字。重新載入，確認標籤真的進了資料庫。
  await page.reload();
  const reloaded = page.locator(`li.row:has([data-testid="profile-tag-input"][data-lesson-id="${id}"])`);
  await expect(reloaded.getByTestId('profile-tag-list')).toContainText(tag);
  await expect(reloaded.getByTestId('profile-tag-input')).toHaveValue(tag);

  const removed = await page.request.delete(`/api/lessons/${id}`, {
    headers: { 'x-csrftoken': token },
  });
  expect(removed.ok()).toBe(true);
});
