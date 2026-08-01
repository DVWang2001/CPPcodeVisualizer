import { test, expect } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

test('the library workbench exposes its account, search, and desktop columns', async ({ page }) => {
  await ensureLoggedIn(page);
  await page.goto('/');

  await expect(page.getByTestId('account-nav-profile')).toBeVisible();
  await expect(page.getByTestId('lesson-browse-search')).toBeVisible();
  await expect(page.getByTestId('lesson-browse-columns')).toBeVisible();
});

test('the library workbench does not overflow a phone viewport', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await ensureLoggedIn(page);
  await page.goto('/');

  await expect(page.getByTestId('account-nav-profile')).toBeVisible();
  await expect(page.getByTestId('lesson-browse-search')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.close();
});

test('a maximum-length tag does not overflow a phone workbench row', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await ensureLoggedIn(page);
  await page.goto('/edit');
  await page.waitForFunction(() => (window as any).monaco?.editor?.getModels()?.length > 0);
  const token = await page.evaluate(() => (window as any).initial_data.csrf_token);
  const created = await page.request.post('/api/lessons', {
    headers: { 'x-csrftoken': token, 'Content-Type': 'application/json' },
    data: { title: '長標籤版面測試', bundle: { version: '2.0', fullname_to_render: '', source_code: 'int main(){}\n', breakpoints: [], program_input: '' } },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).id;

  try {
    const tagged = await page.request.post(`/api/lessons/${id}/tags`, {
      headers: { 'x-csrftoken': token, 'Content-Type': 'application/json' },
      data: { tags: '測'.repeat(24) },
    });
    expect(tagged.status()).toBe(200);
    await page.goto('/');
    await expect(page.getByTestId('lesson-browse-tag').filter({ hasText: '測'.repeat(24) })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await page.request.delete(`/api/lessons/${id}`, { headers: { 'x-csrftoken': token } });
    await context.close();
  }
});
