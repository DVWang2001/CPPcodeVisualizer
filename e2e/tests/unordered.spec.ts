import { test, expect } from '@playwright/test';
import { runToBreakpoint } from './helpers';

test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await runToBreakpoint(page);
});

// ── unordered_map ─────────────────────────────────────────────────────────────

test('unordered_map: row shows key=42 value=99', async ({ page }) => {
    const rows = page.locator('[data-testid="container-um"] [data-testid="container-row"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-key', '42');
    await expect(rows.first()).toHaveAttribute('data-value', '99');
});

test('unordered_map: Size badge shows Size: 1', async ({ page }) => {
    await expect(
        page.locator('[data-testid="container-um"]').getByText('Size: 1')
    ).toBeVisible();
});
