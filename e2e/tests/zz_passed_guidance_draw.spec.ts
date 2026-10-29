import { test, expect } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

/**
 * 經過的指導行一律畫出來（靜默通過）。
 *
 * 自動播放的 [continue] / [next] 會跨過中間的指導行，GDB 不停駐在那些行，
 * 舊行為是那些行的畫面與計數都不會更新。新行為：中間經過的指導行靜默畫出
 * （計入造訪次數、不播 TTS），結束後臨時斷點全部清除，只留使用者的斷點。
 *
 * 行號（1-indexed）：
 *   4  square 內的指導行（只有 @guide，沒有 TTS）
 *   8  main 的 [continue]
 *   10 迴圈內呼叫 square 的那一行（有 TTS 文字「累加」，它在靜默期間不能出聲）
 *   12 使用者斷點所在行
 */
const SOURCE = `#include <iostream>
using namespace std;
int square(int x) {
    int y = x * x;  //@ @guide 平方 x={x}
    return y;  //@ @tts [next]
}
int main() {
    int total = 0;  //@ @tts [continue]
    for (int i = 1; i <= 3; i++) {  //@ @tts [next]
        total += square(i);  //@ @tts [next] 累加
    }
    cout << total << "\\n";  //@ @tts [next]
    return 0;  //@ @tts [next]
}`;

const GUIDE_LINE = 4;
const SPEAK_LINE = 10;
const START_LINE = 8;
const END_LINE = 12;

function bundle(breakLines: string[]) {
    return {
        version: '2.0',
        fullname_to_render: '',
        source_code: SOURCE,
        breakpoints: breakLines.map((line) => ({ line, is_normal_breakpoint: true })),
        program_input: '',
    };
}

async function boot(page: any, breakLines: string[]) {
    await ensureLoggedIn(page);
    await page.goto('/edit');
    await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 20_000 });
    await page.waitForSelector('.monaco-editor textarea', { timeout: 20_000 });
    await page.evaluate(() => (window as any).store.set('autoplay_enabled', true));

    await page.locator('input[type="file"][accept=".json"]').setInputFiles({
        name: 'passed-guidance.gdbgui.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(bundle(breakLines))),
    });
    await page.waitForTimeout(2000);

    await page.click('#run_button');
    await page.waitForFunction(
        () => (window as any).store?.get('inferior_program') === 'paused',
        null,
        { timeout: 40_000 }
    );
}

/** 記錄每一次出現過的字幕（與停駐的行號）。 */
async function installSubtitleRecorder(page: any) {
    await page.evaluate(() => {
        const w = window as any;
        w.__subs = [];
        if (w.__subId) clearInterval(w.__subId);
        w.__subId = setInterval(() => {
            const s = w.store?.get('tts_subtitle');
            const f = w.store?.get('paused_on_frame');
            const txt = s ? (s.text || s.fullText || JSON.stringify(s)) : null;
            const last = w.__subs[w.__subs.length - 1];
            const rec = { line: f ? String(f.line) : null, sub: txt };
            if (!last || last.line !== rec.line || last.sub !== rec.sub) w.__subs.push(rec);
        }, 50);
    });
}

/** 在指定行第一次停下來的那一刻擷取快照（自動播放在使用者斷點之後還會繼續走）。 */
async function waitForSnapshotAt(page: any, line: number) {
    await page.waitForFunction(
        (target: string) => {
            const w = window as any;
            const f = w.store?.get('paused_on_frame');
            if (!f || String(f.line) !== target) return false;
            w.__snap = {
                line: String(f.line),
                visitsByLine: w.gdbgui_global_variable?.__line_visit_count || {},
                userBreakpointCount: (w.store?.get('breakpoints') || []).length,
            };
            return true;
        },
        String(line),
        { timeout: 90_000 }
    );
    return await page.evaluate(() => (window as any).__snap);
}

test('[continue] draws passed guidance lines silently and keeps only the user breakpoint', async ({ page }) => {
    page.on('pageerror', (e: any) => console.log(`[PAGE ERROR] ${e.message}`));
    // 起點（第 8 行）與使用者斷點（第 12 行）都要設，否則程式會直接跑到 12，根本不會經過 [continue]。
    await boot(page, [String(START_LINE), String(END_LINE)]);
    await installSubtitleRecorder(page);

    // main 的 [continue] 會跨過迴圈，第一次停在使用者斷點 END_LINE 時擷取快照。
    const s = await waitForSnapshotAt(page, END_LINE);
    console.log('\n=== [continue] LANDED ===\n' + JSON.stringify(s.visitsByLine));
    const subs = await page.evaluate(() => (window as any).__subs);
    console.log('=== SUBTITLES ===\n' + JSON.stringify(subs, null, 1));

    // 1. 停在使用者斷點。
    expect(s.line).toBe(String(END_LINE));

    // 2. 經過的指導行有畫出（計入造訪次數）：square 呼叫三次，每次都經過第 4 行。
    expect(s.visitsByLine[String(GUIDE_LINE)] || 0, '指導行必須靜默畫出').toBe(3);
    expect(s.visitsByLine[String(SPEAK_LINE)] || 0, '迴圈內的指導行必須靜默畫出').toBe(3);

    // 3. 靜默經過的行不播 TTS：「累加」不應出現在字幕中。
    const spoke = subs.filter((r: any) => r.sub && String(r.sub).includes('累加'));
    expect(spoke, '靜默經過的行不能出聲').toEqual([]);

    // 4. 臨時斷點清除，只剩使用者的斷點。
    expect(s.userBreakpointCount, '臨時斷點必須全部清除（只剩兩個使用者斷點）').toBe(2);
});

test('[next] over a call draws the callee guidance line silently', async ({ page }) => {
    page.on('pageerror', (e: any) => console.log(`[PAGE ERROR] ${e.message}`));
    // 使用者斷點在 SPEAK_LINE；自動播放的 [next] 會跨過 square 的內部。
    await boot(page, [String(SPEAK_LINE)]);
    await installSubtitleRecorder(page);

    // 迴圈跑完、第一次停在 END_LINE 時擷取快照。
    const s = await waitForSnapshotAt(page, END_LINE);
    console.log('\n=== [next] LANDED ===\n' + JSON.stringify(s.visitsByLine));

    // 1. 三次 square 呼叫內的指導行都被畫過。
    expect(s.visitsByLine[String(GUIDE_LINE)] || 0, 'callee 內的指導行必須靜默畫出').toBe(3);

    // 2. 字幕中沒有 square 內指導行的旁白（它只有 @guide，沒有 TTS）。
    const subs = await page.evaluate(() => (window as any).__subs);
    const fromCallee = subs.filter((r: any) => r.line === String(GUIDE_LINE) && r.sub);
    expect(fromCallee, 'callee 內的靜默行不能出聲').toEqual([]);

    // 3. 臨時斷點清除。
    expect(s.userBreakpointCount, '臨時斷點必須全部清除').toBe(1);
});
