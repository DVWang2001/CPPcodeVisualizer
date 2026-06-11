import { Page, expect } from '@playwright/test';

const E2E_BP_LINE = 26;
export const E2E_GUIDE = '{v} {a} {s} {l} {st} {q} {dq} {se} {ms} {m} {mm} {um}';

/**
 * Must be called BEFORE page.goto('/').
 * Sets auto_add_breakpoint_to_main=false in localStorage so BinaryLoader's
 * componentDidMount (triggered by initial_binary_and_args from CLI) does NOT
 * send -break-insert -f main.  Without this, GDB stops at main (line 29)
 * before e2e_bp (line 26), and processing_guide never fires.
 */
export async function setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
        localStorage.setItem('auto_add_breakpoint_to_main', 'false');
    });
}

/**
 * Wait for gdbgui to initialise, then inject the guide annotation directly onto
 * window.gdbgui_global_variable.__line so processing_guide() finds it when GDB
 * stops at line E2E_BP_LINE.  We bypass localStorage because componentDidMount
 * runs asynchronously and may fire after processing_guide() is already called.
 */
export async function setupGuide(page: Page, guide = E2E_GUIDE): Promise<void> {
    await page.waitForFunction(
        () => (window as any).gdbgui_global_variable !== undefined,
        null,
        { timeout: 10_000 }
    );
    await page.evaluate(({ line, guide }) => {
        const g = (window as any).gdbgui_global_variable;
        if (!g.__line) g.__line = {};
        g.__line[line] = guide;
        g.__line[String(line)] = guide;
    }, { line: E2E_BP_LINE, guide });
}

export async function waitForContainerData(page: Page, timeoutMs = 15_000): Promise<void> {
    await page.waitForFunction(
        () => { const g = (window as any).gdbgui_global_variable; return g?.__latest_containers?.size > 0; },
        null,
        { timeout: timeoutMs }
    );
}

/**
 * Wait until a specific container name appears in __latest_containers.
 * Use in beforeAll after runToBreakpoint to ensure the spec's slowest container
 * is fully loaded before any tests start.
 */
export async function waitForContainer(page: Page, name: string, timeoutMs = 20_000): Promise<void> {
    await page.waitForFunction(
        (n) => { const g = (window as any).gdbgui_global_variable; return g?.__latest_containers?.has(n); },
        name,
        { timeout: timeoutMs }
    );
}

export async function runToBreakpoint(page: Page, guide = E2E_GUIDE): Promise<void> {
    // Forward browser console to test output
    page.on('console', msg => console.log(`[browser] ${msg.type()}: ${msg.text()}`));

    console.log('[e2e] runToBreakpoint: setupGuide start');
    await setupGuide(page, guide);
    console.log('[e2e] runToBreakpoint: setupGuide done, overriding get_editor_value');
    await page.evaluate(() => {
        const origPaused = (window as any).Actions?.inferior_program_paused;
        if (origPaused) {
            (window as any).Actions.inferior_program_paused = function(frame: any) {
                console.log('[DBG] inferior_program_paused called, frame=', JSON.stringify(frame));
                return origPaused.call(this, frame);
            };
        }
        (window as any).gdbgui_get_editor_value = () => "";
    });
    console.log('[e2e] runToBreakpoint: clicking #run_button');
    await page.click('#run_button');
    console.log('[e2e] runToBreakpoint: click done, waiting for container data');
    await waitForContainerData(page);
    console.log('[e2e] runToBreakpoint: container data ready');
}

export async function enableBSTMode(page: Page, containerName: string): Promise<void> {
    const wrapper = page.locator(`[data-testid="container-${containerName}"]`);
    const checkbox = wrapper.locator('label:has-text("BST模式") input[type="checkbox"]');
    // Skip re-enabling if already active (shared page reuse)
    if (!await checkbox.isChecked()) {
        await checkbox.check();
        await page.waitForFunction(
            () => (window as any).gdbgui_bst_anim_done == null,
            null,
            { timeout: 15_000 }
        );
    }
    await expect(wrapper.locator('[data-testid="bst-tree"] svg circle').first()).toBeVisible();
}
