import { test, expect, Page } from '@playwright/test';
import { ensureLoggedIn, setupPage } from './helpers';

/**
 * /tutorial：需登入；點章節載入教案；在任何一行按 Enter 直接執行到那一行並停住，
 * 目標行以前的 @layout open: 先把面板開好；改 //@ 後再按 Enter 用新文字；
 * 連續改兩次都要生效（Run 之後編輯器不可變唯讀）。
 */

test('unauthenticated /tutorial redirects to login', async ({ page }) => {
  await page.goto('/tutorial');
  await expect(page).toHaveURL(/\/login/);
});

async function openT1(page: Page) {
  await setupPage(page);
  await ensureLoggedIn(page);
  await page.goto('/tutorial');
  await page.waitForSelector('#tutorial_doc');
  await page.waitForSelector('.monaco-editor textarea', { timeout: 15_000 });
  await page.click('[data-project="t1"]');
  await expect(page.locator('#tutorial_title')).toContainText('tts 念出變數');
  await expect(page.locator('#tutorial_steps li')).toHaveCount(2);
  // 文件式版面：底部終端機拿掉
  await expect(page.locator('#bottom')).toBeHidden();
}

async function waitPausedAt(page: Page, line: number) {
  await page.waitForFunction(
    (n) => {
      const s = (window as any).store;
      return s.get('inferior_program') === 'paused' && String(s.get('paused_on_frame')?.line) === String(n);
    },
    line,
    { timeout: 90_000 }, // 第一次 Run 要下載 wasm 編譯器
  );
}

async function editTtsLineAndEnter(page: Page, suffix: string) {
  await page.locator('.view-line', { hasText: '@tts' }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(suffix);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (s) => String((window as any).store.get('tts_subtitle')?.text || '').includes(s),
    suffix,
    { timeout: 90_000 },
  );
}

test('home banner and IDE top-bar button both lead to /tutorial', async ({ page }) => {
  await ensureLoggedIn(page);
  await page.goto('/');
  await page.getByTestId('tutorial-entry').click();
  await expect(page).toHaveURL(/\/tutorial/);
  await page.goto('/edit');
  await page.getByTestId('go-tutorial').click();
  await expect(page).toHaveURL(/\/tutorial/);
});

test('Enter on a plain code line (no annotation) runs straight to it', async ({ page }) => {
  await openT1(page);
  // 第 9 行 cout：沒有任何註解，仍然要停在這行
  await page.locator('.view-line', { hasText: 'cout' }).first().click();
  await page.keyboard.press('Enter');
  await waitPausedAt(page, 9);
});

test('pressing Enter again on the same line steps through visits and wraps after n', async ({ page }) => {
  await openT1(page);
  await page.click('#tutorial_list summary');
  await page.click('[data-project="g3"]');
  const press = async (label: string) => {
    await page.keyboard.press('Enter');
    await expect(page.locator('#tutorial_visit')).toContainText(label, { timeout: 90_000 });
    await page.waitForFunction(() => (window as any).store.get('inferior_program') === 'paused', null, { timeout: 20_000 });
  };
  await page.locator('.view-line', { hasText: 'sum += i' }).first().click();
  await press('1 / 3');
  await press('2 / 3');
  await press('3 / 3');
  await press('1 / 3'); // 第 n 次之後回到第 1 次
});

test('edit //@ line + Enter replays with the new text, twice in a row', async ({ page }) => {
  await openT1(page);
  await editTtsLineAndEnter(page, '，第一次');
  await editTtsLineAndEnter(page, '第二次');
  // 字幕帶：播放模式出現，顯示剛改的旁白（第二次改的字）
  await expect(page.locator('#tutorial_caption')).toBeVisible();
  await expect(page.locator('#tutorial_caption')).toContainText('第二次');
});
