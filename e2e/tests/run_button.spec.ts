import { test, expect } from '@playwright/test';
import { containersBundle, ensureLoggedIn, setupPage, waitForContainerData } from './helpers';

test('Run button produces container data within 30 seconds', async ({ page }) => {
    await setupPage(page);
    await ensureLoggedIn(page);
    await page.goto('/edit');
    await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 15_000 });
    await page.waitForSelector('.monaco-editor textarea', { timeout: 15_000 });
    await page.locator('input[type="file"][accept=".json"]').setInputFiles({
        name: 'e2e_containers.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(containersBundle())),
    });
    await page.waitForTimeout(1500);
    const start = Date.now();
    await page.click('#run_button');
    // wasm engine: the first Run downloads the compiler assets, so the old
    // 3-second GDB budget no longer applies.
    await waitForContainerData(page, 30_000);

    const elapsed = Date.now() - start;
    console.log(`Run button responded in ${elapsed} ms`);
    expect(elapsed).toBeLessThan(30_000);
});
