import { test, expect } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

/**
 * `[fast @N]` — silently fast-forward until the annotated line has been visited
 * N times, then narrate normally.
 *
 * The whole point is state fidelity: every line is still stepped, so the tree,
 * the call graph and the visit counts are all correct on arrival. That is what
 * separates this from `[continue]`, and it is what assertion 3 below measures.
 *
 * Loop is `for (int i = 1; i <= n; i++)` with n = 5, so line 7 is visited:
 *   visit 1 = init (i=1),  visit 2..6 = increment/condition after each body run.
 * `[fast @{n}]` therefore lands on visit 5, with the body having run 4 times,
 * i.e. s == {2,4,6,8}.
 */

// Every stop carries an autoplay command — the project's hard rule, and without
// it autoplay never starts. All of them except the landing line are
// command-only (no text), which executes immediately with no audio, so this
// spec does not depend on the TTS service being reachable.
const SOURCE = `#include <iostream>
#include <set>
using namespace std;
int main() {
    set<int> s;  //@ @tts [next] @layout sidebar:55 open:container bst:s
    int n = 5;  //@ @tts [next]
    for (int i = 1; i <= n; i++) {  //@ @guide {s} @tts [fast @{n}] 前面幾圈略過，現在 i={i}
        s.insert(i * 2);  //@ @tts [next]
    }
    cout << s.size() << "\\n";  //@ @tts [next]
    return 0;  //@ @tts [next]
}  //@ @tts [continue]`;

const LOOP_LINE = 7;

const BUNDLE = {
    version: '2.0',
    fullname_to_render: '',
    source_code: SOURCE,
    breakpoints: [{ line: '4', is_normal_breakpoint: true }],
    program_input: '',
};

async function boot(page: any, autoplay: boolean) {
    await ensureLoggedIn(page);
    await page.goto('/edit');
    await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 20_000 });
    await page.waitForSelector('.monaco-editor textarea', { timeout: 20_000 });
    await page.evaluate((ap: boolean) => (window as any).store.set('autoplay_enabled', ap), autoplay);

    await page.locator('input[type="file"][accept=".json"]').setInputFiles({
        name: 'fastfwd.gdbgui.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(BUNDLE)),
    });
    await page.waitForTimeout(2000);

    await page.click('#run_button');
    await page.waitForFunction(
        () => (window as any).store?.get('inferior_program') === 'paused',
        null,
        { timeout: 40_000 }
    );
}

/** Records every distinct subtitle the lesson ever showed. */
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

async function state(page: any) {
    return await page.evaluate((loopLine: number) => {
        const w = window as any;
        const f = w.store?.get('paused_on_frame');
        const g = w.gdbgui_global_variable;
        const cont = g?.__latest_containers?.get('s');
        return {
            line: f ? String(f.line) : null,
            visits: g?.__line_visit_count?.[loopLine] || 0,
            values: cont ? cont.values.map((v: any) => String(v)) : null,
            armed: !!g?.__fast_forward,
        };
    }, LOOP_LINE);
}

test('[fast @{n}] lands on the Nth visit with the container state intact', async ({ page }) => {
    page.on('pageerror', (e: any) => console.log(`[PAGE ERROR] ${e.message}`));
    await boot(page, true);
    await installSubtitleRecorder(page);

    // Wait for the fast-forward to arm and then finish. It disarms on landing.
    await page.waitForFunction(
        (loopLine: number) => {
            const w = window as any;
            const g = w.gdbgui_global_variable;
            const f = w.store?.get('paused_on_frame');
            return !g?.__fast_forward
                && f && String(f.line) === String(loopLine)
                && (g?.__line_visit_count?.[loopLine] || 0) >= 5;
        },
        LOOP_LINE,
        { timeout: 60_000 }
    );
    await page.waitForTimeout(1500);

    const s = await state(page);
    console.log('\n=== LANDED ===\n' + JSON.stringify(s));
    const subs = await page.evaluate(() => (window as any).__subs);
    console.log('=== SUBTITLES ===\n' + JSON.stringify(subs, null, 1));

    // 1. Landed on the right stop.
    expect(s.line).toBe(String(LOOP_LINE));
    expect(s.visits, 'must land on exactly the 5th visit, not overshoot').toBe(5);
    expect(s.armed, 'fast-forward should have disarmed on landing').toBe(false);

    // 2. Nothing was narrated on the way. Every subtitle recorded before landing
    //    must be empty -- an armed pause returns before setting tts_subtitle.
    const beforeLanding = subs.filter((r: any) => !(r.line === String(LOOP_LINE) && r.sub));
    expect(beforeLanding.every((r: any) => !r.sub),
        `a subtitle appeared during fast-forward: ${JSON.stringify(subs)}`).toBe(true);

    // 3. State fidelity -- the reason this is not just [continue]. Four body runs
    //    happened silently and every one of them was still observed.
    expect(s.values, 'container must reflect all skipped iterations').toEqual(['2', '4', '6', '8']);
});

test('[fast @{n}] does not arm when autoplay is off', async ({ page }) => {
    page.on('pageerror', (e: any) => console.log(`[PAGE ERROR] ${e.message}`));
    await boot(page, false);

    // Step until we first reach the loop line.
    for (let i = 0; i < 8; i++) {
        const s = await state(page);
        if (s.line === String(LOOP_LINE)) break;
        await page.click('#next_button');
        await page.waitForTimeout(700);
    }
    const atLoop = await state(page);
    expect(atLoop.line, 'never reached the loop line').toBe(String(LOOP_LINE));
    expect(atLoop.armed, 'must not arm while autoplay is off').toBe(false);

    // One press must advance one step, not blow through four iterations.
    await page.click('#next_button');
    await page.waitForTimeout(1200);
    const after = await state(page);
    console.log(`\n=== manual step: ${JSON.stringify(atLoop)} -> ${JSON.stringify(after)} ===`);
    expect(after.visits, 'manual stepping must not fast-forward').toBeLessThan(5);
});
