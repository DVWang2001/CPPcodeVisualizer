import { test } from '@playwright/test';
import { setupPage } from './helpers';
import * as fs from 'fs';

const TUTORIAL = {
  version: "1.0",
  project_name: "gdbgui_project",
  source_code: `#include <iostream>
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
}`,
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

async function importTutorial(page: any) {
  const fileInput = page.locator('input[type="file"][accept=".json"]');
  await fileInput.setInputFiles({
    name: '10_swap_concepts.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(TUTORIAL)),
  });
  await page.waitForTimeout(1500);
}

async function waitPaused(page: any) {
  await page.waitForTimeout(300);
  await page.waitForFunction(
    () => (window as any).store.get('inferior_program') === 'paused',
    null, { timeout: 30_000 }
  );
  await page.waitForTimeout(1200);
}

async function getInfo(page: any) {
  return page.evaluate(() => {
    const g = (window as any).gdbgui_global_variable;
    const exprs = g?.__active_visualizer_exprs ? Array.from(g.__active_visualizer_exprs) : [];
    const stack = ((window as any).store.get('stack') || []).map((f: any) => `${f.func}@${f.line}`);
    const frame = (window as any).store.get('paused_on_frame');
    return { exprs, stack, line: frame?.line, func: frame?.func };
  });
}

test('MemoryWatch screenshots through swap tutorial', async ({ page }) => {
  const outDir = '/e2e/test-results/memwatch';
  fs.mkdirSync(outDir, { recursive: true });

  page.on('console', msg => console.log(`[browser] ${msg.type()}: ${msg.text()}`));

  await setupPage(page);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 15_000 });
  await page.waitForSelector('.monaco-editor textarea', { timeout: 15_000 });

  // Disable autoplay + TTS
  await page.evaluate(() => {
    (window as any).store.set('autoplay_enabled', false);
    window.speechSynthesis?.cancel();
  });

  await importTutorial(page);

  // Run — should compile and hit first breakpoint
  await page.click('#run_button');
  await waitPaused(page);

  let info = await getInfo(page);
  console.log(`[step 01] line=${info.line} func=${info.func} exprs=${JSON.stringify(info.exprs)} stack=${JSON.stringify(info.stack)}`);

  // Open memory panel
  await page.evaluate(() => {
    const reg = (window as any).gdbgui_collapser_registry;
    if (reg?.memory_watch) reg.memory_watch.open();
  });
  await page.waitForTimeout(500);

  await page.screenshot({ path: `${outDir}/01_line${info.line}.png`, fullPage: true });

  // Step through with continue button, take screenshot at each stop
  for (let step = 2; step <= 12; step++) {
    await page.click('#continue_button');
    try {
      await waitPaused(page);
    } catch {
      console.log(`[step ${String(step).padStart(2, '0')}] timeout — program may have exited`);
      await page.screenshot({ path: `${outDir}/${String(step).padStart(2, '0')}_exited.png`, fullPage: true });
      break;
    }

    info = await getInfo(page);
    const label = `${String(step).padStart(2, '0')}_line${info.line}`;
    console.log(`[step ${label}] func=${info.func} exprs=${JSON.stringify(info.exprs)} stack=${JSON.stringify(info.stack)}`);

    // Ensure memory panel is open
    await page.evaluate(() => {
      const reg = (window as any).gdbgui_collapser_registry;
      if (reg?.memory_watch) reg.memory_watch.open();
    });
    await page.waitForTimeout(500);

    await page.screenshot({ path: `${outDir}/${label}.png`, fullPage: true });

    // Also screenshot just the memory_watch panel if it exists
    const panel = page.locator('#memory_watch');
    if (await panel.count() > 0 && await panel.isVisible()) {
      await panel.screenshot({ path: `${outDir}/${label}_panel.png` });
    }
  }
});
