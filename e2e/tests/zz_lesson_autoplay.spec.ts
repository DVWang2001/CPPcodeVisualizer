/**
 * 教案自動播放的驗收測試 —— AUTHORING_GUIDE 1.3 的硬性標準：
 *
 *   「Import 教案、按下 Run 之後，不需要任何手動步進，教案要自己一路播放到程式結束。」
 *
 * 既有的 playback specs 都測不到這條路徑：
 *   - zz_for_substep 直接呼叫 gdbgui_run_autoplay_command('next')，繞過「TTS 結束
 *     觸發下一步」這個真正的驅動來源，也繞過周邊還在飛的 -var-create 流量
 *   - zz_bst_animation / memwatch_screenshot / zz_for_substep 的其餘測試把
 *     autoplay_enabled 關掉
 *   - 全部都跑 e2e 容器啟動時編好的固定 binary，不是教案自己的程式
 *
 * 所以這支從教案建立開始，只按一次 Run，之後完全不碰，看它會不會自己播完。
 *
 * rec_sum 是對照組：它沒有 STL 容器。如果連它都紅，是這支測試寫壞了，不是產品壞了。
 */
import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import * as path from 'path';

/** 每篇最多等這麼久：每個停駐點都要唸完一段 TTS，真的很慢。 */
const PLAY_TIMEOUT_MS = 150_000;
/** 連續這麼久沒有任何新的停駐點，就判定播放已經死了。 */
const STALL_MS = 30_000;

type Result = {
  lines: number[];
  finalState: string;
  stalledAtLine: number | null;
  elapsedMs: number;
};

function bundleOf(name: string): any {
  return JSON.parse(
    readFileSync(path.resolve(__dirname, `../../examples/cpp/${name}.gdbgui.json`), 'utf8')
  );
}

async function register(page: Page): Promise<void> {
  const username = `ap${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/register');
  await page.fill('#username', username);
  await page.fill('#display_name', 'Autoplay');
  await page.fill('#password', 'autoplay-probe-1234');
  await Promise.all([page.waitForURL(/\/(edit|u\/)/), page.click('#submit')]);
}

/** 建教案 → 開啟 → 按一次 Run → 之後完全不碰，記錄它走過哪些行。 */
async function playLesson(page: Page, name: string): Promise<Result> {
  await register(page);
  await page.addInitScript(() => localStorage.setItem('show_tour_guide', 'false'));
  await page.goto('/edit');
  await page.waitForFunction(
    () => (window as any).monaco?.editor?.getModels()?.length > 0,
    null,
    { timeout: 60_000 }
  );

  const token = await page.evaluate(() => (window as any).initial_data.csrf_token);
  const created = await page.request.post('/api/lessons', {
    headers: { 'x-csrftoken': token, 'Content-Type': 'application/json' },
    data: { title: `autoplay ${name} ${Date.now()}`, bundle: bundleOf(name) },
  });
  expect(created.status(), '建立教案').toBe(201);
  const id = (await created.json()).id;

  await page.goto(`/edit?lesson=${id}`);
  await page.waitForFunction(
    () => (window as any).monaco?.editor?.getModels()?.length > 0,
    null,
    { timeout: 60_000 }
  );
  await page.waitForTimeout(3000);

  // 唯一的一次人為操作。
  await page.click('#run_button');

  const lines: number[] = [];
  const started = Date.now();
  let lastProgressAt = Date.now();
  let finalState = 'unknown';

  while (Date.now() - started < PLAY_TIMEOUT_MS) {
    const snap = await page.evaluate(() => {
      const w = window as any;
      return {
        state: String(w.store?.get?.('inferior_program')),
        line: w.store?.get?.('line_of_source_to_flash'),
      };
    });
    finalState = snap.state;

    if (snap.state === 'paused' && typeof snap.line === 'number' && !Number.isNaN(snap.line)) {
      if (lines[lines.length - 1] !== snap.line) {
        lines.push(snap.line);
        lastProgressAt = Date.now();
      }
    }
    if (snap.state === 'exited') break;
    if (Date.now() - lastProgressAt > STALL_MS) {
      return {
        lines,
        finalState,
        stalledAtLine: lines.length ? lines[lines.length - 1] : null,
        elapsedMs: Date.now() - started,
      };
    }
    await page.waitForTimeout(500);
  }

  return { lines, finalState, stalledAtLine: null, elapsedMs: Date.now() - started };
}

function report(name: string, r: Result): string {
  return (
    `教案 ${name}：走過 ${r.lines.length} 個停駐點 [${r.lines.join(' → ')}]，` +
    `最終狀態 ${r.finalState}，耗時 ${Math.round(r.elapsedMs / 1000)}s` +
    (r.stalledAtLine !== null ? `，停在第 ${r.stalledAtLine} 行不動` : '')
  );
}

// 對照組先跑：它若紅，代表這支測試本身有問題。
for (const name of ['rec_sum', 'c_vector', 'set_bounds']) {
  test(`${name}：按一次 Run 之後自己播到程式結束`, async ({ page }) => {
    test.setTimeout(PLAY_TIMEOUT_MS + 90_000);
    const r = await playLesson(page, name);
    console.log('\n' + report(name, r) + '\n');

    expect(r.stalledAtLine, `播放中途卡死 — ${report(name, r)}`).toBeNull();
    expect(r.lines.length, `播放沒有推進到多個停駐點 — ${report(name, r)}`).toBeGreaterThan(2);
    expect(r.finalState, `程式沒有跑到結束 — ${report(name, r)}`).toBe('exited');
  });
}
