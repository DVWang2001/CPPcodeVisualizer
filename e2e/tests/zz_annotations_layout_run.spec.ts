import { test, expect } from '@playwright/test';
import { ensureLoggedIn, setupPage } from './helpers';

/**
 * B1 — Regression for the "__layout wiped on Run" bug fixed in 244bd66.
 *
 * After the annotations refactor, per-line layout directives live as `//@ @layout ...`
 * comments in the source and are parsed into window.gdbgui_global_variable.__layout.
 * GdbApi.run_initial_commands() clears global_variable on Run but must PRESERVE
 * __line/__tts/__layout. The bug: __layout was NOT in the preserve list, so every
 * layout directive silently stopped applying once the user pressed Run.
 *
 * This test imports a v1 bundle (exercising the v1->v2 bundleAdapter too), confirms
 * __layout is populated from the baked-in //@ comment, then presses Run and asserts
 * __layout SURVIVES reaching 'paused'. Without the fix, __layout would be {} here.
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
  // line 5 (`int a = 10;`) carries a layout directive and a breakpoint
  line_data: {
    '5': { guide: 'a 的值', tts: '', layout: 'sidebar:60 open:memory' },
  },
  program_input: '',
  breakpoints: [
    { number: '1', line: '5', enabled: 'y', is_normal_breakpoint: true, is_parent_breakpoint: false, is_child_breakpoint: false, fullname_to_display: '' },
  ],
};

function readLayout(page: any) {
  return page.evaluate(() => {
    const g = (window as any).gdbgui_global_variable;
    return g && g.__layout ? { ...g.__layout } : {};
  });
}

test('layout directive survives Run (regression: __layout not wiped)', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('console', msg => console.log(`[browser] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err => { jsErrors.push(err.message); console.log(`[PAGE ERROR] ${err.message}`); });

  await setupPage(page);
  await ensureLoggedIn(page);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 15_000 });
  await page.waitForSelector('.monaco-editor textarea', { timeout: 15_000 });

  // record inferior_program states so we can await 'paused'
  await page.evaluate(() => {
    (window as any).__test_states = [];
    const origSet = (window as any).store.set;
    (window as any).store.set = function (...args: any[]) {
      if (args[0] === 'inferior_program') (window as any).__test_states.push(args[1]);
      return origSet.apply(this, args);
    };
  });

  // Import the v1 bundle -> bundleAdapter bakes line_data into //@ comments in the source.
  await page.locator('input[type="file"][accept=".json"]').setInputFiles({
    name: 'b1_layout.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(BUNDLE)),
  });
  await page.waitForTimeout(1500);

  // Precondition: the baked //@ @layout parsed into __layout for line 5.
  const beforeRun = await readLayout(page);
  console.log('[e2e] __layout before Run:', JSON.stringify(beforeRun));
  expect(beforeRun['5']).toBeTruthy();
  expect(beforeRun['5']).toContain('open:memory');

  // Run to the breakpoint.
  await page.click('#run_button');
  const reachedPaused = await page.waitForFunction(
    () => (window as any).__test_states.some((s: string) => s === 'paused'),
    null,
    { timeout: 30_000 },
  ).then(() => true).catch(() => false);
  expect(reachedPaused).toBe(true);

  // The actual regression assertion: __layout must NOT have been wiped by
  // run_initial_commands. Before the fix, this object was {} after Run.
  const afterRun = await readLayout(page);
  console.log('[e2e] __layout after paused:', JSON.stringify(afterRun));
  expect(afterRun['5']).toBeTruthy();
  expect(afterRun['5']).toContain('open:memory');

  expect(jsErrors).toEqual([]);
});
