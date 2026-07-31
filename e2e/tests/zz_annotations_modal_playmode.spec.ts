import { test, expect } from '@playwright/test';
import { setupPage } from './helpers';

/**
 * The per-line ✎ inline panel must let the user edit a line's `//@` annotation
 * while the editor is readOnly (play mode) — the annotation authoring path now
 * that the code itself is locked during execution. Save goes through
 * model.pushEditOperations (readOnly-safe). This replaces the old right-click/
 * Ctrl+Shift+E modal (which could not be driven under Playwright).
 *
 * Named zz_ so its session-replacing import runs after session-dependent specs.
 */

const BUNDLE = {
  version: '1.0', project_name: 'gdbgui_project',
  source_code: "#include <iostream>\nusing namespace std;\n\nint main() {\n    int a = 10;\n    int b = 20;\n    std::cout << a << b << std::endl;\n    return 0;\n}",
  line_data: { "5": { guide: "a 的值", tts: "", layout: "" } },
  program_input: '', breakpoints: [],
};
const GUIDE = 'E2E_PLAY_MODE_GUIDE';

test('✎ inline panel writes //@ while editor is readOnly (play mode)', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('console', msg => console.log(`[browser] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err => { jsErrors.push(err.message); console.log(`[PAGE ERROR] ${err.message}`); });

  await setupPage(page);
  await page.goto('/edit');
  await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 15_000 });
  await page.waitForSelector('.monaco-editor textarea', { timeout: 15_000 });

  await page.locator('input[type="file"][accept=".json"]').setInputFiles({
    name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(BUNDLE)),
  });
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => ((window as any).gdbgui_get_editor_value?.() || '').includes('int b = 20'), null, { timeout: 10_000 });

  // Force play-mode readOnly.
  await page.evaluate(() => (window as any).store.set('edit_mode', false));
  await expect(page.locator('.gdbgui-readonly-editor')).toHaveCount(1, { timeout: 5_000 });

  // Hover line 6's content (`int b = 20;`, no annotation yet) to reveal the ✎ widget
  // (it follows the hovered line, anchored past end-of-code), then click it.
  await page.locator('.view-line', { hasText: 'int b = 20' }).first().hover({ force: true });
  await page.locator('.gdbgui-annot-edit-glyph').first().click({ force: true });

  await expect(page.getByTestId('line-annot-panel')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('annot-guide').fill(GUIDE);
  await page.getByTestId('annot-save').click();
  await expect(page.getByTestId('line-annot-panel')).toBeHidden({ timeout: 5_000 });

  const value: string = await page.evaluate(() => (window as any).gdbgui_get_editor_value());
  const line6 = value.split('\n')[5] || '';
  console.log('[e2e] line 6 after save:', line6);
  expect(line6).toContain('//@');
  expect(line6).toContain(GUIDE);
  expect(jsErrors).toEqual([]);
});
