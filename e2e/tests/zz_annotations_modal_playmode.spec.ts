import { test, expect } from '@playwright/test';
import { setupPage } from './helpers';

/**
 * B2 — The line-editor modal must write its `//@` comment into the source even
 * when the Monaco editor is readOnly (play mode). The fix (656d7a6) switched the
 * modal's save from `editor.executeEdits` (a no-op while readOnly) to
 * `model.pushEditOperations` (model-level, readOnly-agnostic).
 *
 * We import a small bundle for deterministic content, force play-mode readOnly
 * via `store.set('edit_mode', false)` (the app wires `readOnly: !edit_mode`),
 * open the modal on an un-annotated line via its Ctrl+Shift+E action, type a
 * guide, save, and assert the `//@` now exists on that line. If save were still
 * gated by readOnly, the content would be unchanged.
 *
 * Named zz_ so it runs LAST: it imports/replaces the shared GDB session binary,
 * which would otherwise break session-dependent specs that run after it.
 */

const BUNDLE = {
  version: '1.0',
  project_name: 'gdbgui_project',
  source_code: `#include <iostream>
using namespace std;

int main() {
    int a = 10;
    int b = 20;
    std::cout << a << b << std::endl;
    return 0;
}`,
  line_data: {
    '5': { guide: 'a 的值', tts: '', layout: '' },
  },
  program_input: '',
  breakpoints: [],
};

const GUIDE_TEXT = 'E2E_PLAY_MODE_GUIDE';

/**
 * SKIPPED: could not be automated against monaco-editor 0.21.2 in the Playwright
 * harness. The editor's modal trigger (right-click / Ctrl+Shift+E) could not be
 * driven — a `#top` overlay intercepts editor pointer events (blocking both the
 * left-click needed for keybinding focus and the right-click context menu), and
 * monaco 0.21 exposes no editor handle (no `monaco.editor.getEditors`) to invoke
 * the action programmatically.
 *
 * MANUAL VERIFICATION (do this once in the running app):
 *   1. Load/import a source, press Run so the editor enters play mode (readOnly).
 *   2. Right-click a source line (or press Ctrl+Shift+E) -> the "行編輯器" modal opens.
 *   3. Type guide text on the Guide tab, click 儲存.
 *   4. Confirm a `//@ @guide ...` comment appears on that line (proves the
 *      model.pushEditOperations save works while the editor is readOnly).
 */
test.skip('modal save writes //@ into source while editor is readOnly (play mode)', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('console', msg => console.log(`[browser] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err => { jsErrors.push(err.message); console.log(`[PAGE ERROR] ${err.message}`); });

  await setupPage(page);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 15_000 });
  await page.waitForSelector('.monaco-editor textarea', { timeout: 15_000 });

  // Import for deterministic editor content.
  await page.locator('input[type="file"][accept=".json"]').setInputFiles({
    name: 'b2_modal.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(BUNDLE)),
  });
  await page.waitForTimeout(1500);

  // Wait until the imported source is actually in the editor (line 6 = `int b = 20;`).
  await page.waitForFunction(
    () => ((window as any).gdbgui_get_editor_value?.() || '').includes('int b = 20'),
    null,
    { timeout: 10_000 },
  );

  // Force play-mode readOnly (the app renders Monaco with readOnly: !edit_mode).
  await page.evaluate(() => (window as any).store.set('edit_mode', false));
  await expect(page.locator('.gdbgui-readonly-editor')).toHaveCount(1, { timeout: 5_000 });

  // Place the cursor on line 6 (`int b = 20;`, no annotation yet) and open the modal
  // via its Ctrl+Shift+E action. Use keyboard nav (focus + Ctrl+Home + ArrowDown) rather
  // than clicking the line — a #top overlay intercepts pointer events over the editor.
  // Open the line editor via the right-click context menu (registered with
  // contextMenuGroupId "navigation"). Monaco renders the menu in a body-level overlay,
  // so its item is not blocked by the #top overlay that intercepts editor clicks.
  // Only the source editor carries `gdbgui-readonly-editor`.
  await page.locator('.gdbgui-readonly-editor .view-line', { hasText: 'int b = 20' })
    .first().click({ button: 'right', force: true });
  await page.getByText('Edit Line Annotation').click({ timeout: 5_000 });
  // Confirm the modal opened (header shows "第 N 行 — 行編輯器").
  await expect(page.getByText('行編輯器')).toBeVisible({ timeout: 5_000 });

  // Modal opens on the Guide tab. Fill the guide textarea and save.
  const guide = page.locator('textarea[placeholder*="輸入指導文字"]');
  await expect(guide).toBeVisible({ timeout: 5_000 });
  await guide.fill(GUIDE_TEXT);
  await page.locator('button:has-text("儲存")').click();
  await expect(guide).toBeHidden({ timeout: 5_000 }); // modal closed

  // Editor is genuinely readOnly, yet the //@ landed on line 6.
  const value: string = await page.evaluate(() => (window as any).gdbgui_get_editor_value());
  const line6 = value.split('\n')[5] || '';
  console.log('[e2e] line 6 after save:', line6);
  expect(line6).toContain('//@');
  expect(line6).toContain(GUIDE_TEXT);

  expect(jsErrors).toEqual([]);
});
