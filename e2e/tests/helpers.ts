import { Page, expect } from '@playwright/test';

const E2E_CPP_FILE = '/app/examples/cpp/e2e_containers.cpp';
const E2E_BP_LINE = 26;
const E2E_GUIDE = '{v} {a} {s} {l} {st} {q} {dq} {se} {ms} {m} {mm} {um}';

/**
 * Register a localStorage init script and reload so SourceCode.tsx reads the guide
 * annotations before React mounts.  Must be called after page.goto() but before
 * clicking Run (the reload resets the page while preserving GDB state on the server).
 */
export async function setupGuide(page: Page): Promise<void> {
    await page.addInitScript(`
        localStorage.setItem(
            "gdbgui_autosave",
            JSON.stringify({
                version: "1.0",
                fullname_to_render: "${E2E_CPP_FILE}",
                line_data: { "${E2E_BP_LINE}": { guide: "${E2E_GUIDE}" } }
            })
        );
        localStorage.setItem(
            "gdbgui_guide_inputs_${E2E_CPP_FILE}",
            JSON.stringify({ "${E2E_BP_LINE}": "${E2E_GUIDE}" })
        );
        localStorage.setItem("gdbgui_last_edited_filename", "${E2E_CPP_FILE}");
    `);
    await page.reload();
    await page.waitForFunction(() => (window as any).gdbgui_global_variable !== undefined, { timeout: 10_000 });
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
