import { test, expect, Page } from '@playwright/test';
import { runToBreakpoint, setupPage, waitForContainer } from './helpers';

let page: Page;

test.describe('unordered containers', () => {
    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        await setupPage(page);
        await page.goto('/');
        await runToBreakpoint(page, '{um}');
        await waitForContainer(page, 'um');
    });

    test.afterAll(async () => {
        await page?.close();
    });

    // ── unordered_map ─────────────────────────────────────────────────────────────

    test('unordered_map: row shows key=42 value=99', async () => {
        const rows = page.locator('[data-testid="container-um"] [data-testid="container-row"]');
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toHaveAttribute('data-key', '42');
        await expect(rows.first()).toHaveAttribute('data-value', '99');
    });

    test('unordered_map: Size badge shows Size: 1', async () => {
        await expect(
            page.locator('[data-testid="container-um"]').getByText('Size: 1')
        ).toBeVisible();
    });
});
