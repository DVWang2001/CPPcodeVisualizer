/**
 * 標籤與瀏覽。後端授權由 tests/test_tags_api.py 覆蓋；這裡只驗前端接得上：
 * 在個人檔案頁貼標籤 → 主頁搜尋得到 → 點標籤能縮小清單。
 */
import { test, expect, Page } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

async function csrfToken(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).initial_data.csrf_token);
}

test('tag a lesson, then find it by搜尋 and by clicking the tag', async ({ page }) => {
  await ensureLoggedIn(page);
  await page.goto('/edit');
  await page.waitForFunction(() => (window as any).monaco?.editor?.getModels()?.length > 0);
  const token = await csrfToken(page);

  const stamp = Date.now();
  const title = `標籤測試 ${stamp}`;
  const tag = `e2etag${stamp}`;

  const created = await page.request.post('/api/lessons', {
    headers: { 'x-csrftoken': token, 'Content-Type': 'application/json' },
    data: {
      title,
      bundle: { version: '2.0', fullname_to_render: '', source_code: 'int main(){}\n',
                breakpoints: [], program_input: '' },
    },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).id;

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

  // 收乾淨
  await page.request.delete(`/api/lessons/${id}`, {
    headers: { 'x-csrftoken': token },
  });
});

test('the tag editor on your own profile writes tags', async ({ page }) => {
  await ensureLoggedIn(page);
  await page.goto('/edit');
  await page.waitForFunction(() => (window as any).monaco?.editor?.getModels()?.length > 0);
  const token = await csrfToken(page);

  const stamp = Date.now();
  const created = await page.request.post('/api/lessons', {
    headers: { 'x-csrftoken': token, 'Content-Type': 'application/json' },
    data: {
      title: `編輯器測試 ${stamp}`,
      bundle: { version: '2.0', fullname_to_render: '', source_code: 'int main(){}\n',
                breakpoints: [], program_input: '' },
    },
  });
  const id = (await created.json()).id;

  // 找到自己的個人檔案頁
  await page.goto('/');
  await page.getByTestId('lesson-browse-author').first().click();

  const input = page.getByTestId('profile-tag-input').first();
  await input.fill(`profiletag${stamp}`);
  await page.getByTestId('profile-tag-save').first().click();
  await expect(page.locator('.tag-edit .status').first()).toHaveText('已儲存');

  await page.request.delete(`/api/lessons/${id}`, {
    headers: { 'x-csrftoken': token },
  });
});
