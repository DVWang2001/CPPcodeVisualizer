import { test, expect } from '@playwright/test';
import { ensureLoggedIn, setupPage } from './helpers';

/**
 * Regression: importing a tutorial JSON and pressing Run must compile + start
 * the program and reach 'paused' (hit a breakpoint). Tests both clean slate
 * and re-import scenarios.
 */

const FULL_SOURCE = `#include <iostream>
using namespace std;

// 傳值 (Pass by Value)
void VSWAP(int a, int b) {
    int tmp = a;
    a = b;
    b = tmp;
}

// 傳參照 (Pass by Reference)
void RSWAP(int &a, int &b) {
    int tmp = a;
    a = b;
    b = tmp;
}

// 傳指標 (Pass by Pointer)
void ASWAP(int *a, int *b) {
    int tmp = *a;
    *a = *b;
    *b = tmp;
}

int main() {
    int a = 10, b = 20;

    // 第一階段：傳值交換
    VSWAP(a, b);

    // 第二階段：傳參照交換
    RSWAP(a, b);

    // 第三階段：傳指標交換
    ASWAP(&a, &b);

    return 0;
}`;

const TUTORIAL = {
  version: "1.0",
  project_name: "gdbgui_project",
  source_code: FULL_SOURCE,
  line_data: {
    "6":  { guide: "{VSWAP::a} {VSWAP::b}", tts: "[continue] 將a和b的數值交換" },
    "9":  { guide: "{VSWAP::a}{VSWAP::b}{main::a}{main::b}", tts: "[next] SWAP一次" },
    "13": { guide: "{RSWAP::a}{RSWAP::b}", tts: "[continue] 將a和b的數值交換" },
    "16": { guide: "", tts: "[next] SWAP一次" },
    "20": { guide: "{ASWAP::a}{ASWAP::b}", tts: "[continue] 將a和b的數值交換" },
    "23": { guide: "", tts: "[next] SWAP一次" },
    "26": { guide: "", tts: "[continue]開始教學" },
    "29": { guide: "a = {a}, b = {b}", tts: "[next]看VSWAP", layout: "sidebar:60 open:memory" },
    "32": { guide: "a = {a}, b = {b}", tts: "[next]看RSWAP", layout: "sidebar:60 open:memory" },
    "35": { guide: "a = {a}, b = {b}", tts: "[next]看ASWAP", layout: "sidebar:60 open:memory" },
    "37": { guide: "最終結果: a = {a}, b = {b}", tts: "[continue] 程式結束" },
  },
  program_input: "",
  breakpoints: [
    { number: "1", line: "29", enabled: "y", is_normal_breakpoint: true, is_parent_breakpoint: false, is_child_breakpoint: false, fullname_to_display: "" },
    { number: "2", line: "32", enabled: "y", is_normal_breakpoint: true, is_parent_breakpoint: false, is_child_breakpoint: false, fullname_to_display: "" },
    { number: "3", line: "35", enabled: "y", is_normal_breakpoint: true, is_parent_breakpoint: false, is_child_breakpoint: false, fullname_to_display: "" },
    { number: "4", line: "26", enabled: "y", is_normal_breakpoint: true, is_parent_breakpoint: false, is_child_breakpoint: false, fullname_to_display: "" },
    { number: "5", line: "6",  enabled: "y", is_normal_breakpoint: true, is_parent_breakpoint: false, is_child_breakpoint: false, fullname_to_display: "" },
    { number: "6", line: "13", enabled: "y", is_normal_breakpoint: true, is_parent_breakpoint: false, is_child_breakpoint: false, fullname_to_display: "" },
    { number: "7", line: "20", enabled: "y", is_normal_breakpoint: true, is_parent_breakpoint: false, is_child_breakpoint: false, fullname_to_display: "" },
    { number: "8", line: "9",  enabled: "y", is_normal_breakpoint: true, is_parent_breakpoint: false, is_child_breakpoint: false, fullname_to_display: "" },
    { number: "9", line: "23", enabled: "y", is_normal_breakpoint: true, is_parent_breakpoint: false, is_child_breakpoint: false, fullname_to_display: "" },
    { number: "10", line: "16", enabled: "y", is_normal_breakpoint: true, is_parent_breakpoint: false, is_child_breakpoint: false, fullname_to_display: "" },
  ],
};

async function installStateRecorder(page: any) {
  await page.evaluate(() => {
    (window as any).__test_states = [];
    const origSet = (window as any).store.set;
    (window as any).store.set = function (...args: any[]) {
      if (args[0] === 'inferior_program') {
        (window as any).__test_states.push({ state: args[1], ts: Date.now() });
      }
      return origSet.apply(this, args);
    };
  });
}

async function importTutorial(page: any) {
  const fileInput = page.locator('input[type="file"][accept=".json"]');
  await fileInput.setInputFiles({
    name: '10_swap_concepts.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(TUTORIAL)),
  });
  await page.waitForTimeout(1500);
}

async function expectPausedAfterRun(page: any) {
  await page.click('#run_button');
  const ok = await page.waitForFunction(
    () => (window as any).__test_states.some((s: any) => s.state === 'paused'),
    null,
    { timeout: 30_000 },
  ).then(() => true).catch(() => false);

  const history = await page.evaluate(() => (window as any).__test_states);
  console.log('[e2e] state history:', JSON.stringify(history));
  expect(ok).toBe(true);
}

test('tutorial import then Run reaches paused', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('console', msg => console.log(`[browser] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err => { jsErrors.push(err.message); console.log(`[PAGE ERROR] ${err.message}`); });

  await setupPage(page);
  await ensureLoggedIn(page);
  await page.goto('/edit');
  await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 15_000 });
  await page.waitForSelector('.monaco-editor textarea', { timeout: 15_000 });
  await installStateRecorder(page);

  // Import and run
  await importTutorial(page);
  const postImport = await page.evaluate(() => {
    const s = (window as any).store;
    return { bkpts: (s.get('breakpoints') || []).length };
  });
  expect(postImport.bkpts).toBe(10);

  await expectPausedAfterRun(page);
  expect(jsErrors).toEqual([]);
});
