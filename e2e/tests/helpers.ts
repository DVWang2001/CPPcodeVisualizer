import { Page, expect } from '@playwright/test';

/** Wait until gdbgui's ContainerVisualizer has received data from GDB. */
export async function waitForContainerData(page: Page, timeoutMs = 15_000): Promise<void> {
    await page.waitForFunction(
        () => {
            const g = (window as any).gdbgui_global_variable;
            return g?.__latest_containers?.size > 0;
        },
        { timeout: timeoutMs }
    );
}

/**
 * Click Run, then wait until all containers are populated.
 * The test binary halts at e2e_bp() so all variables are in scope.
 */
export async function runToBreakpoint(page: Page): Promise<void> {
    await page.click('#run_button');
    await waitForContainerData(page);
}

/**
 * Enable BST mode for a container and wait for the SVG tree to fully render.
 * Waits for the AnimScheduler barrier to clear before asserting DOM state.
 */
export async function enableBSTMode(page: Page, containerName: string): Promise<void> {
    const wrapper = page.locator(`[data-testid="container-${containerName}"]`);
    await wrapper.locator('label:has-text("BST模式") input[type="checkbox"]').check();
    await page.waitForFunction(
        () => (window as any).gdbgui_bst_anim_done == null,
        { timeout: 15_000 }
    );
    await expect(wrapper.locator('[data-testid="bst-tree"] svg circle').first()).toBeVisible();
}
