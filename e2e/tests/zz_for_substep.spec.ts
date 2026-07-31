import { test, expect } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

/**
 * for (A; B; C) three-phase stepping, Visual Studio style.
 *
 * B can never be its own GDB stop (it shares an address block with C, and GDB
 * exposes no column info), so it is a UI-only "virtual step": pressing Next on
 * A or C swaps the highlight without issuing -exec-next.
 *
 * Two things are worth guarding, and they fail in different ways:
 *   1. the segment sequence itself, and that a virtual step really does NOT
 *      advance the program (paused line must stay put);
 *   2. the autoplay continuation — a virtual step produces no GDB pause, so
 *      nothing would schedule the next command and playback would deadlock.
 */

const SOURCE = `#include <iostream>
int main() {
    int sum = 0;
    for (int i = 0; i < 3; i++) {
        sum += i;
    }
    std::cout << sum << "\\n";
    return 0;
}`;

const FOR_LINE = '4';
const BODY_LINE = '5';

const BUNDLE = {
    version: '2.0',
    fullname_to_render: '',
    source_code: SOURCE,
    breakpoints: [{ line: '2', is_normal_breakpoint: true }],
    program_input: '',
};

/** `${line}:${segment}` — the full observable step state. */
async function stateKey(page: any): Promise<string> {
    return await page.evaluate(() => {
        const w = window as any;
        const f = w.store?.get('paused_on_frame');
        const sub = w.store?.get('for_sub_step');
        return `${f ? f.line : '-'}:${sub ? sub.seg : '-'}`;
    });
}

async function stepOnce(page: any) {
    const before = await stateKey(page);
    await page.click('#next_button');
    await page.waitForFunction(
        (prev: string) => {
            const w = window as any;
            const f = w.store?.get('paused_on_frame');
            const sub = w.store?.get('for_sub_step');
            return `${f ? f.line : '-'}:${sub ? sub.seg : '-'}` !== prev;
        },
        before,
        { timeout: 15_000 }
    );
    await page.waitForTimeout(250);
}

async function bootLesson(page: any) {
    await ensureLoggedIn(page);
    await page.goto('/edit');
    await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 20_000 });
    await page.waitForSelector('.monaco-editor textarea', { timeout: 20_000 });
    await page.evaluate(() => (window as any).store.set('autoplay_enabled', false));

    await page.locator('input[type="file"][accept=".json"]').setInputFiles({
        name: 'forloop.gdbgui.json',
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
    await page.waitForTimeout(1000);
}

test('for loop steps A -> B -> body -> C -> B, and virtual steps do not advance the program', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e: any) => { pageErrors.push(e.message); console.log(`[PAGE ERROR] ${e.message}`); });
    await bootLesson(page);

    const seen: string[] = [await stateKey(page)];
    let decorationsOnB = 0;
    for (let i = 0; i < 12; i++) {
        await stepOnce(page);
        const key = await stateKey(page);
        seen.push(key);
        if (key === `${FOR_LINE}:B`) {
            decorationsOnB = Math.max(
                decorationsOnB,
                await page.locator('.for_seg_active').count()
            );
        }
    }
    console.log('\n=== STEP SEQUENCE ===\n' + seen.join('\n'));

    // Trim the lead-in (int sum = 0;) and look at the loop itself.
    const loop = seen.slice(seen.findIndex(s => s.startsWith(`${FOR_LINE}:`)));

    // One full iteration, twice over, is enough to pin the pattern down.
    expect(loop.slice(0, 7)).toEqual([
        `${FOR_LINE}:A`,      // init — real GDB stop
        `${FOR_LINE}:B`,      // condition — virtual step
        `${BODY_LINE}:-`,     // body — real step
        `${FOR_LINE}:C`,      // increment — real GDB stop
        `${FOR_LINE}:B`,      // condition again — virtual
        `${BODY_LINE}:-`,
        `${FOR_LINE}:C`,
    ]);

    // A must appear exactly once: the loop is entered once, so the init block
    // runs once. If the A/C rule were counting visits instead of comparing
    // addresses this would drift.
    expect(loop.filter(s => s === `${FOR_LINE}:A`)).toHaveLength(1);

    // The whole point of a virtual step: the program does not move.
    const bodyAfterB = seen.filter((s, i) => i > 0 && seen[i - 1] === `${FOR_LINE}:A`);
    expect(bodyAfterB[0], 'stepping off A must stay on the for line').toBe(`${FOR_LINE}:B`);

    // The highlight decoration must actually be in the DOM on a virtual step.
    expect(decorationsOnB, 'no inline segment decoration rendered on the B step').toBeGreaterThan(0);

    // Stepping past the loop must not throw — the paused line can move outside
    // the editor model (program exit, library frame) and the decoration path
    // calls getLineContent, which rejects out-of-range line numbers.
    expect(seen[seen.length - 1], 'should have left the loop by now').toBe('7:-');
    expect(pageErrors, 'the decoration path threw while stepping').toEqual([]);
});

test('autoplay continues through a virtual step instead of deadlocking', async ({ page }) => {
    page.on('pageerror', (e: any) => console.log(`[PAGE ERROR] ${e.message}`));
    await bootLesson(page);

    // Get onto the for line's A segment.
    while (await stateKey(page) !== `${FOR_LINE}:A`) await stepOnce(page);

    // Drive the autoplay-flagged path directly. A virtual step issues no GDB
    // command, so without the scheduled continuation this call is the last
    // thing that ever happens and playback hangs here forever.
    await page.evaluate(() => {
        (window as any).store.set('autoplay_enabled', true);
        // The same entry point the TTS "[next]" prefix ultimately reaches.
        (window as any).gdbgui_run_autoplay_command('next');
    });

    // One call should carry us through B (virtual) and on to the body (real),
    // without any further clicks.
    await page.waitForFunction(
        (bodyLine: string) => {
            const f = (window as any).store?.get('paused_on_frame');
            return f && String(f.line) === bodyLine;
        },
        BODY_LINE,
        { timeout: 15_000 }
    );

    const reached = await stateKey(page);
    console.log(`\n=== autoplay carried us to: ${reached} ===`);
    expect(reached).toBe(`${BODY_LINE}:-`);
});
