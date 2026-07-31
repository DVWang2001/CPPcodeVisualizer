import { test, expect } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

test('main page returns HTTP 200 and contains gdbgui in title', async ({ page }) => {
    await ensureLoggedIn(page);
    const response = await page.goto('/edit');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/gdbgui/i);
});

test('WebSocket connection is established', async ({ page }) => {
    await ensureLoggedIn(page);
    await page.goto('/edit');
    await page.waitForFunction(
        () => (window as any).gdbgui_global_variable !== undefined,
        { timeout: 10_000 }
    );
});

test('GDB terminal toggle button is present', async ({ page }) => {
    await ensureLoggedIn(page);
    await page.goto('/edit');
    await expect(page.getByText('查看 Terminal')).toBeVisible({ timeout: 10_000 });
});
