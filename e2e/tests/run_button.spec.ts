import { test, expect } from '@playwright/test';
import { waitForContainerData } from './helpers';

// When GDB hits the e2e_bp() breakpoint, all containers are populated.
// We use container data availability as the "program responded" signal —
// it requires the full pipeline (GDB run → breakpoint hit → data extraction → WebSocket → DOM).
test('Run button causes GDB to respond within 3 seconds', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
        () => (window as any).gdbgui_global_variable !== undefined,
        { timeout: 10_000 }
    );

    const start = Date.now();
    await page.click('#run_button');
    await waitForContainerData(page, 3_000);

    const elapsed = Date.now() - start;
    console.log(`Run button responded in ${elapsed} ms`);
    expect(elapsed).toBeLessThan(3_000);
});
