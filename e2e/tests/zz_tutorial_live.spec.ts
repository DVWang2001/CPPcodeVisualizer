import { test, expect, Page } from '@playwright/test';
import { ensureLoggedIn, setupPage } from './helpers';

/**
 * /tutorial：需登入；點章節載入教案；在含 //@ 的行改字後按 Enter，
 * 程式重跑並停在該行，字幕反映「剛改的」文字；連續改兩次都要生效
 * （Run 之後編輯器不可變唯讀）。
 */

test('unauthenticated /tutorial redirects to login', async ({ page }) => {
  await page.goto('/tutorial');
  await expect(page).toHaveURL(/\/login/);
});

async function editTtsLineAndEnter(page: Page, suffix: string) {
  await page.locator('.view-line', { hasText: '@tts' }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(suffix);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (s) => String((window as any).store.get('tts_subtitle')?.text || '').includes(s),
    suffix,
    { timeout: 90_000 }, // 第一次 Run 要下載 wasm 編譯器
  );
  await page.waitForFunction(
    () => (window as any).store.get('inferior_program') === 'paused',
    null,
    { timeout: 20_000 },
  );
}

test('edit //@ line + Enter replays with the new text, twice in a row', async ({ page }) => {
  await setupPage(page);
  await ensureLoggedIn(page);
  await page.goto('/tutorial');
  await page.waitForSelector('#tutorial_shell');
  await page.waitForSelector('.monaco-editor textarea', { timeout: 15_000 });

  await page.click('[data-project="t1"]');
  await expect(page.locator('#tutorial_current')).toContainText('tts 念出變數');

  await editTtsLineAndEnter(page, '，第一次');
  await editTtsLineAndEnter(page, '第二次');
});
