import { test, expect } from '@playwright/test';
import { ensureLoggedIn, setupPage } from './helpers';

/**
 * /tutorial：需登入；點章節載入教案；在含 //@ 的行改字後按 Enter，
 * 程式重跑並停在該行，字幕反映「剛改的」文字。
 */

test('unauthenticated /tutorial redirects to login', async ({ page }) => {
  await page.goto('/tutorial');
  await expect(page).toHaveURL(/\/login/);
});

test('edit //@ line + Enter replays with the new text', async ({ page }) => {
  await setupPage(page);
  await ensureLoggedIn(page);
  await page.goto('/tutorial');
  await page.waitForSelector('#tutorial_shell');
  await page.waitForSelector('.monaco-editor textarea', { timeout: 15_000 });

  await page.click('[data-project="t1"]');
  await expect(page.locator('#tutorial_current')).toContainText('目標');

  // 把 tts 文字改成唯一字串，游標放在該行再按 Enter
  const line = await page.evaluate(() => {
    const ed = (window as any).monaco.editor.getEditors()[0];
    const model = ed.getModel();
    const n = model.getLinesContent().findIndex((l: string) => l.includes('@tts')) + 1;
    const text = model.getLineContent(n).replace(/@tts .*/, '@tts 教學測試句 {i}');
    ed.executeEdits('e2e', [{ range: model.getFullModelRange().setStartPosition(n, 1).setEndPosition(n, model.getLineMaxColumn(n)), text }]);
    ed.setPosition({ lineNumber: n, column: 1 });
    ed.focus();
    return n;
  });
  expect(line).toBeGreaterThan(0);

  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (window as any).store.get('inferior_program') === 'paused',
    null,
    { timeout: 90_000 }, // 第一次 Run 要下載 wasm 編譯器
  );
  await page.waitForFunction(
    () => String((window as any).store.get('tts_subtitle') || '').includes('教學測試句'),
    null,
    { timeout: 20_000 },
  );
});
