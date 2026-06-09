import { test, expect } from '@playwright/test';
import { waitForContainerData, setupGuide } from './helpers';

test('Run button causes GDB to respond within 3 seconds', async ({ page }) => {
    await page.goto('/');
    await setupGuide(page);

    const start = Date.now();
    await page.click('#run_button');
    await waitForContainerData(page, 3_000);

    const elapsed = Date.now() - start;
    console.log(`Run button responded in ${elapsed} ms`);
    expect(elapsed).toBeLessThan(3_000);
});
