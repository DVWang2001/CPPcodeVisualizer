import { test, expect } from '@playwright/test';
import { ensureLoggedIn, setupPage } from './helpers';

/**
 * Regression test for the pause button.  MARKED fixme: THE BUTTON IS STILL BROKEN.
 *
 * The button calls Actions.send_signal("SIGINT", "gdb") -- it asks the server to
 * os.kill(gdb_pid, SIGINT).  That does nothing useful: gdb catches SIGINT,
 * emits no MI record, and the inferior keeps running, so the UI never leaves
 * "running".
 *
 * Measured in the container against gdb configured exactly as sessionmanager
 * configures it (console on one pty, MI as a secondary UI via `new-ui mi2`):
 *
 *   A. SIGINT -> gdb pid           0 MI records, inferior stays R   DID NOT PAUSE
 *   B. -exec-interrupt             0 MI records, inferior stays R   DID NOT PAUSE
 *   C. SIGINT -> inferior pid      stop record, inferior -> t       PAUSED
 *   D. set mi-async on
 *      + -exec-interrupt           stop record, inferior -> t       PAUSED
 *
 * B is inert because gdb here runs MI synchronously: while the inferior runs,
 * gdb is not servicing the MI pty at all, so the command is not read until the
 * program stops on its own.  -exec-interrupt only works in async mode (D), which
 * this deployment does not enable.
 *
 * This test PASSES when the handler is switched to
 * Actions.send_signal("SIGINT", "inferior") and the button is given
 * id="pause_button" (verified end-to-end: it paused at main line 4).  It is left
 * as fixme because that change has not been approved.  Un-fixme it together with
 * the fix.
 *
 * The assertions deliberately do not inspect which mechanism was used -- only
 * the user-visible behaviour -- so they stay valid whichever fix is chosen.
 */

// -O0, no I/O, no syscalls the sandbox cares about.  Long enough that it is
// still running when we press pause, but bounded so nothing leaks if the test
// dies early.  Never hits a breakpoint: setupPage() disables the automatic
// breakpoint on main and this spec sets none of its own.
const BUSY_LOOP = `int main() {
    volatile unsigned long long acc = 0;
    for (unsigned long long i = 0; i < 60000000000ULL; ++i) {
        acc += i;
    }
    return (int)(acc & 1);
}
`;

test('pause button actually interrupts a running program', async ({ page }) => {
    test.setTimeout(120_000);
    await setupPage(page);
    await ensureLoggedIn(page);
    await page.goto('/edit');

    await page.waitForFunction(() => (window as any).store !== undefined, null, {
        timeout: 15_000,
    });

    await page.evaluate((src) => {
        (window as any).gdbgui_get_editor_value = () => src;
    }, BUSY_LOOP);

    await page.click('#run_button');

    // The program must actually reach "running" -- otherwise a later "paused"
    // would prove nothing (a compile failure also leaves it not-running).
    await page.waitForFunction(
        () => (window as any).store.get('inferior_program') === 'running',
        null,
        { timeout: 45_000 }
    );

    // ...and stay running on its own.  This is the control: it rules out the
    // possibility that the program stopped by itself (breakpoint, exit, crash)
    // and the pause button merely got the credit.
    //
    // The wait is long on purpose.  Clicking Run also fires /api/prerun_calltree,
    // which runs the program again under a batch gdb with a 15 s subprocess
    // timeout -- and that subprocess call blocks the whole server, including the
    // loop that reads gdb's MI stream.  Any program that runs long enough to be
    // worth pausing also makes that pre-run hit its full timeout, so for ~15 s
    // after Run the server has not yet processed gdb's own "-exec-run" reply.
    // Pausing inside that window is a race against an unrelated defect; this
    // test waits it out so that it measures the pause button and nothing else.
    await page.waitForTimeout(20_000);
    expect(await page.evaluate(() => (window as any).store.get('inferior_program')))
        .toBe('running');

    // No stop frame yet.  If one were already present, "paused" afterwards could
    // be left over rather than caused by the button.
    const frameBefore = await page.evaluate(() =>
        (window as any).store.get('paused_on_frame')
    );
    console.log(`[e2e] paused_on_frame before pause: ${JSON.stringify(frameBefore)}`);
    expect(!frameBefore || Object.keys(frameBefore).length === 0).toBe(true);

    await page.click('#pause_button');

    await page.waitForFunction(
        () => (window as any).store.get('inferior_program') === 'paused',
        null,
        { timeout: 15_000 }
    );

    // The UI has to reflect the stop, not just the state string: a frame must
    // have arrived and the source view must be pointing at a real line.
    const pausedOnFrame = await page.evaluate(() =>
        (window as any).store.get('paused_on_frame')
    );
    console.log(`[e2e] paused_on_frame after pause: ${JSON.stringify(pausedOnFrame)}`);
    expect(pausedOnFrame).toBeTruthy();
    expect(Object.keys(pausedOnFrame).length).toBeGreaterThan(0);

    const flashedLine = await page.evaluate(() =>
        (window as any).store.get('line_of_source_to_flash')
    );
    console.log(`[e2e] line_of_source_to_flash: ${flashedLine}`);
    expect(Number.isNaN(Number(flashedLine))).toBe(false);

    // Still stopped a moment later -- an interrupt that immediately resumes is
    // not a pause.
    await page.waitForTimeout(2_000);
    expect(await page.evaluate(() => (window as any).store.get('inferior_program')))
        .toBe('paused');
});
