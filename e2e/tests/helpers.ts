import { Page, expect } from '@playwright/test';

const E2E_BP_LINE = 26;
const E2E_GUIDE = '{v} {a} {s} {l} {st} {q} {dq} {se} {ms} {m} {mm} {um}';

/**
 * Wait for gdbgui to initialise, then inject the guide annotation directly onto
 * window.gdbgui_global_variable.__line so processing_guide() finds it when GDB
 * stops at line E2E_BP_LINE.  We bypass localStorage because componentDidMount
 * runs asynchronously and may fire after processing_guide() is already called.
 */
export async function setupGuide(page: Page): Promise<void> {
    await page.waitForFunction(
        () => (window as any).gdbgui_global_variable !== undefined,
        { timeout: 10_000 }
    );
    await page.evaluate(({ line, guide }) => {
        const g = (window as any).gdbgui_global_variable;
        if (!g.__line) g.__line = {};
        g.__line[line] = guide;
        g.__line[String(line)] = guide;
    }, { line: E2E_BP_LINE, guide: E2E_GUIDE });
}

export async function waitForContainerData(page: Page, timeoutMs = 15_000): Promise<void> {
    await page.waitForFunction(
        () => { const g = (window as any).gdbgui_global_variable; return g?.__latest_containers?.size > 0; },
        { timeout: timeoutMs }
    );
}

export async function runToBreakpoint(page: Page): Promise<void> {
    await setupGuide(page);
    await page.click('#run_button');
    await waitForContainerData(page);
}

export async function enableBSTMode(page: Page, containerName: string): Promise<void> {
    const wrapper = page.locator(`[data-testid="container-${containerName}"]`);
    await wrapper.locator('label:has-text("BST模式") input[type="checkbox"]').check();
    await page.waitForFunction(
        () => (window as any).gdbgui_bst_anim_done == null,
        { timeout: 15_000 }
    );
    await expect(wrapper.locator('[data-testid="bst-tree"] svg circle').first()).toBeVisible();
}
