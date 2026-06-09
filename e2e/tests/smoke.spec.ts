import { test, expect } from '@playwright/test';

test('main page returns HTTP 200 and contains gdbgui in title', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/gdbgui/i);
});

test('WebSocket connection is established', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
        () => (window as any).gdbgui_global_variable !== undefined,
        { timeout: 10_000 }
    );
});

test('GDB terminal pane is visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#gdb_terminal_id')).toBeVisible({ timeout: 10_000 });
});
