/**
 * 教案庫工作台的版面。教案用 examples/cpp/rec_sum.gdbgui.json 並且**走編輯器 UI
 * 存檔**（不是打 /api/lessons）：這條路徑才會經過 lessonBundleForSave()，也才是
 * 使用者真的會做的事。留在站上的教案因此是打得開的真教案。
 */
import { test, expect, Page } from '@playwright/test';
import { ensureLoggedIn, realLessonBundle } from './helpers';

const LESSON = realLessonBundle('rec_sum');

async function csrfToken(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).initial_data.csrf_token);
}

/**
 * 在編輯器裡打好真教案的程式碼，按「存到我的帳號」，回傳新教案 id 與 CSRF token。
 *
 * 必須在桌面尺寸下呼叫：390px 視窗裡編輯器工具列會被 #top 的浮層蓋住，
 * 存檔鍵永遠 intercept（實測重試 23 次都點不到）。要驗的是教案庫的手機版面，
 * 不是編輯器的手機版面，所以建立階段用桌面尺寸，之後再縮。
 *
 * token 必須在還在 /edit 時取：window.initial_data 只有除錯器頁面有，
 * 到了教案庫就讀不到了。
 */
async function saveLessonThroughEditor(
  page: Page,
  title: string
): Promise<{ id: number; token: string }> {
  await page.addInitScript(() => localStorage.setItem('show_tour_guide', 'false'));
  await page.goto('/edit');
  await page.waitForFunction(() => (window as any).monaco?.editor?.getModels()?.length > 0);
  await page.evaluate(
    (src) => (window as any).monaco.editor.getModels()[0].setValue(src),
    LESSON.source_code
  );

  // saveLessonToAccount 用 window.prompt 問標題。Playwright 預設會自動 dismiss
  // 對話框（prompt 回 null），那會讓存檔直接放棄，所以必須自己接。
  page.once('dialog', (dialog) => dialog.accept(title));
  await page.getByTestId('save-lesson-to-account').click();
  const token = await csrfToken(page);

  await page.goto('/');
  const link = page.getByTestId('lesson-browse-title').filter({ hasText: title }).first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  const id = Number(new URL(href!, page.url()).searchParams.get('lesson'));
  expect(Number.isInteger(id) && id > 0).toBe(true);
  return { id, token };
}

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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await ensureLoggedIn(page);

  const { id, token } = await saveLessonThroughEditor(page, '長標籤版面測試');
  await page.setViewportSize({ width: 390, height: 844 });

  try {
    // 存進去的必須是真教案的程式碼，不是編輯器預設的 Hello World 模板。
    const stored = await page.request.get(`/api/lessons/${id}`);
    const saved = (await stored.json()).bundle.source_code;
    expect(saved).toContain('int sum(int n)');
    expect(saved).toContain('//@ @guide');
    expect(saved).not.toContain('Hello, World!');

    const tagged = await page.request.post(`/api/lessons/${id}/tags`, {
      headers: { 'x-csrftoken': token, 'Content-Type': 'application/json' },
      data: { tags: '測'.repeat(24) },
    });
    expect(tagged.status()).toBe(200);

    await page.goto('/');
    await expect(page.getByTestId('lesson-browse-tag').filter({ hasText: '測'.repeat(24) })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.setViewportSize({ width: 1280, height: 800 });
    const headingX = await page.locator('[data-testid="lesson-browse-columns"] > span')
      .evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().left)));
    const rowX = await page.locator('[data-testid="lesson-browse-item"]').first().locator(':scope > *')
      .evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().left)));
    expect(rowX).toEqual(headingX);
  } finally {
    const removed = await page.request.delete(`/api/lessons/${id}`, { headers: { 'x-csrftoken': token } });
    expect(removed.ok()).toBe(true);
    await context.close();
  }
});
