import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * End-to-end coverage for the set/multiset BST animations, driven by the real
 * set_bounds lesson bundle against a real GDB session.
 *
 * Guards two regressions found in this flow:
 *
 *  1. Tree lagged one pause behind. A set that had just grown from empty was
 *     misread as empty because the varobj's numchild was still stale, so the
 *     first node only appeared once the set held two elements.
 *
 *  2. find / lower_bound never animated at all. detect_container_op read
 *     `fileObj.source_code_array[lineNum - 1]`, a property that does not exist
 *     on cached file objects (they store the 1-indexed `source_code_obj`), so
 *     the function bailed on every line and no prospective animation ever ran.
 *
 * Annotations fire BEFORE the line executes, so the expected timeline is:
 *   pause on insert(5) -> s == {}    -> 0 nodes
 *   pause on insert(3) -> s == {5}   -> 1 node    <-- regression 1
 *   pause on insert(7) -> s == {5,3} -> 2 nodes
 *
 * Autoplay is off and every pause gets a generous settle window, so a failure
 * means a logic bug, not a race with the lesson's TTS pacing.
 */

const BUNDLE = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../examples/cpp/set_bounds.gdbgui.json'), 'utf8')
);

const LOWER_BOUND_LINE = '16'; // int r1 = *s.lower_bound(3);
const FIND_LINE = '23';        // bool has4 = (s.find(4) != s.end());

type Snap = { line: string | null; values: string[] | null; domNodes: number };

async function snapshot(page: any): Promise<Snap> {
    const state = await page.evaluate(() => {
        const w = window as any;
        const frame = w.store?.get('paused_on_frame');
        const cont = w.gdbgui_global_variable?.__latest_containers?.get('s');
        return {
            line: frame ? String(frame.line) : null,
            values: cont ? cont.values.map((v: any) => String(v)) : null,
        };
    });
    const domNodes = await page.locator('[data-testid="container-s"] [data-testid="bst-node"]').count();
    return { ...state, domNodes };
}

/** Samples the DOM continuously so short-lived animation states are not missed. */
async function installSampler(page: any) {
    await page.evaluate(() => {
        const w = window as any;
        w.__samples = [];
        if (w.__samplerId) clearInterval(w.__samplerId);
        w.__samplerId = setInterval(() => {
            const frame = w.store?.get('paused_on_frame');
            const circles = Array.from(
                document.querySelectorAll('[data-testid="container-s"] [data-testid="bst-node"] circle')
            ) as any[];
            const fill = (c: any) => (c.getAttribute('fill') || '').toLowerCase();
            const cap = document.querySelector('[data-testid="bst-bound-caption"]');
            const groups = Array.from(
                document.querySelectorAll('[data-testid="container-s"] [data-testid="bst-node"]')
            ) as any[];
            w.__samples.push({
                line: frame ? String(frame.line) : null,
                orange: circles.filter(c => fill(c) === '#ff9800').length,
                green: circles.filter(c => fill(c) === '#4caf50').length,
                red: circles.filter(c => fill(c) === '#f44336').length,
                dashed: circles.filter(c => c.getAttribute('stroke-dasharray')).length,
                caption: cap ? cap.textContent : null,
                nodes: groups.length,
                cands: Array.from(
                    document.querySelectorAll('[data-testid="bst-candidate-cell"]')
                ).map((e: any) => e.getAttribute('data-key')).join(','),
                // Layout fingerprint: if this changes while an animation is on
                // screen, the tree was re-laid-out mid-animation.
                layout: groups.map(g => `${g.getAttribute('data-key')}@${(g.style.transform || '').replace(/\s/g, '')}`).join(','),
            });
        }, 50);
    });
}

async function summaryForLine(page: any, line: string) {
    return await page.evaluate((ln: string) => {
        const s = (window as any).__samples.filter((x: any) => x.line === ln);
        const max = (k: string) => Math.max(0, ...s.map((x: any) => x[k]));
        // Samples where a prospective animation was on screen.
        const anim = s.filter((x: any) => x.dashed > 0 || x.caption || x.red > 0);
        return {
            samples: s.length,
            maxOrange: max('orange'), maxGreen: max('green'),
            maxRed: max('red'), maxDashed: max('dashed'),
            captions: Array.from(new Set(s.map((x: any) => x.caption).filter(Boolean))),
            nodeCounts: Array.from(new Set(s.map((x: any) => x.nodes))).sort(),
            // Node counts observed WHILE a prospective animation was visible.
            nodeCountsDuringAnim: Array.from(new Set(anim.map((x: any) => x.nodes))).sort(),
            // Distinct layouts observed while a prospective animation was visible.
            layoutsDuringAnim: Array.from(new Set(anim.map((x: any) => x.layout))).length,
            // Candidate array contents seen over the pause, and its final state.
            candStates: Array.from(new Set(s.map((x: any) => x.cands))),
            candFinal: s.length ? s[s.length - 1].cands : null,
            // Did the result marking survive to the very end of this pause?
            markAtEnd: s.length ? (s[s.length - 1].green > 0 || s[s.length - 1].red > 0) : false,
            layoutAtAnim: anim.length ? anim[0].layout : null,
        };
    }, line);
}

async function stepOnce(page: any) {
    const before = await page.evaluate(() => {
        const f = (window as any).store?.get('paused_on_frame');
        return f ? String(f.line) : null;
    });
    await page.click('#next_button');
    await page.waitForFunction(
        (prev: string) => {
            const f = (window as any).store?.get('paused_on_frame');
            return f && String(f.line) !== prev;
        },
        before,
        { timeout: 20_000 }
    );
    // Wait for the animation pipeline to go idle rather than guessing a duration.
    // gdbgui_bst_anim_done is the app's own "an animation is in flight" barrier —
    // it is what autoplay gates on, so waiting for it mirrors real playback and
    // avoids stepping on top of an animation that is still in its result hold.
    await page.waitForTimeout(400); // let the pause handler reserve the barrier
    await page.waitForFunction(
        () => (window as any).gdbgui_bst_anim_done == null,
        null,
        { timeout: 25_000 }
    ).catch(() => { /* no animation on this line — nothing to wait for */ });
    await page.waitForTimeout(600);
}

test('set lesson: tree keeps pace with inserts, and find / lower_bound animate', async ({ page }) => {
    page.on('pageerror', (e: any) => console.log(`[PAGE ERROR] ${e.message}`));

    await page.goto('/');
    await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 20_000 });
    await page.waitForSelector('.monaco-editor textarea', { timeout: 20_000 });
    await page.evaluate(() => (window as any).store.set('autoplay_enabled', false));

    await page.locator('input[type="file"][accept=".json"]').setInputFiles({
        name: 'set_bounds.gdbgui.json',
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
    await installSampler(page);
    await page.waitForTimeout(2500);

    // ── Regression 1: node count must track the set size, with no extra lag ───
    const timeline: Snap[] = [await snapshot(page)];
    for (let i = 0; i < 5; i++) {
        await stepOnce(page);
        timeline.push(await snapshot(page));
    }
    console.log('\n=== TIMELINE ===');
    for (const s of timeline) {
        console.log(`line=${String(s.line).padStart(3)} values=${JSON.stringify(s.values)} domNodes=${s.domNodes}`);
    }

    const single = timeline.find(s => s.values && s.values.length === 1);
    expect(single, 'no pause observed with exactly one element in s').toBeTruthy();
    expect(single!.domNodes, 'a one-element set must render one node').toBe(1);
    for (const s of timeline) {
        if (s.values) expect(s.domNodes, `node count must match set size at line ${s.line}`).toBe(s.values.length);
    }

    // ── Regression 2: the prospective animations must actually run ────────────
    while (await page.evaluate(() => String((window as any).store?.get('paused_on_frame')?.line)) !== LOWER_BOUND_LINE) {
        await stepOnce(page);
    }
    await page.waitForTimeout(4000);
    const lb = await summaryForLine(page, LOWER_BOUND_LINE);
    console.log(`\n=== lower_bound(3) @ line ${LOWER_BOUND_LINE} ===\n${JSON.stringify(lb)}`);

    while (await page.evaluate(() => String((window as any).store?.get('paused_on_frame')?.line)) !== FIND_LINE) {
        await stepOnce(page);
    }
    await page.waitForTimeout(4000);
    const fd = await summaryForLine(page, FIND_LINE);
    console.log(`\n=== find(4) @ line ${FIND_LINE} ===\n${JSON.stringify(fd)}`);

    // Assert on markers UNIQUE to the prospective animations. A plain orange node
    // is not enough evidence: the insert animation walks a compare path too, and
    // an insert for the previous line fires at this same pause.
    //
    // The blue dashed candidate ring and the caption exist only in _runBound.
    expect(lb.maxDashed, 'lower_bound never drew the candidate ring (_runBound did not run)').toBeGreaterThan(0);
    expect(lb.captions.join('|'), 'lower_bound caption never appeared').toContain('lower_bound(3)');
    expect(lb.maxGreen, 'lower_bound never highlighted its result').toBeGreaterThan(0);

    // find(4) on {1,3,5,7,9} misses, so _runFind must paint the last visited node red.
    expect(fd.maxOrange, 'find never highlighted a comparing node').toBeGreaterThan(0);
    expect(fd.maxRed, 'find never showed a not-found result (_runFind did not run)').toBeGreaterThan(0);

    // ── The prospective animation must not run on a half-built tree ───────────
    // The pending insert from the PREVIOUS line lands at this same pause. If the
    // bound walk starts before that insert is applied, it animates a tree that is
    // missing a node and the layout shifts underneath it mid-walk.
    expect(lb.nodeCountsDuringAnim, 'lower_bound animated while the tree was still incomplete')
        .toEqual([5]);
    expect(lb.layoutsDuringAnim, 'the tree was re-laid-out during the lower_bound animation')
        .toBe(1);
    expect(fd.nodeCountsDuringAnim, 'find animated while the tree was still incomplete')
        .toEqual([5]);
    expect(fd.layoutsDuringAnim, 'the tree was re-laid-out during the find animation')
        .toBe(1);

    // ── The result stays marked until the program advances ────────────────────
    expect(lb.markAtEnd, 'lower_bound result stopped being marked before the next step').toBe(true);
    expect(fd.markAtEnd, 'find result stopped being marked before the next step').toBe(true);

    // ── Candidate array ───────────────────────────────────────────────────────
    // lower_bound(3) on {1,3,5,7,9}: root 5 qualifies and is recorded, then the
    // walk reaches 3, an exact match, which replaces it. find has no candidates.
    expect(lb.candFinal, 'lower_bound candidate array wrong at end of pause').toBe('5,3');
    expect(lb.candStates, 'candidate array should build up as the walk proceeds')
        .toContain('5');
    expect(fd.candFinal, 'find must not show a candidate array').toBe('');

    // Stepping off the line must clear the marks and the array.
    await stepOnce(page);
    const after = await page.evaluate(() => {
        const w = window as any;
        const last = w.__samples[w.__samples.length - 1];
        return { green: last.green, red: last.red, cands: last.cands, caption: last.caption };
    });
    console.log(`\n=== after stepping off find line ===\n${JSON.stringify(after)}`);
    expect(after.green + after.red, 'result mark survived past the next step').toBe(0);
    expect(after.cands, 'candidate array survived past the next step').toBe('');
    expect(after.caption, 'caption survived past the next step').toBeFalsy();
});
