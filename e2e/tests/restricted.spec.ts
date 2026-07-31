import { test, expect, Page } from '@playwright/test';
import { runToBreakpoint, setupPage, waitForContainer } from './helpers';

let page: Page;

test.describe('restricted containers', () => {
    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        await setupPage(page);
        await page.goto('/edit');
        await runToBreakpoint(page, '{st} {q} {dq}');
        await waitForContainer(page, 'dq');
    });

    test.afterAll(async () => {
        await page?.close();
    });

    // ── stack ─────────────────────────────────────────────────────────────────────

    test('stack: cells show 1 and 2', async () => {
        const cells = page.locator('[data-testid="container-st"] [data-testid="container-cell"]');
        await expect(cells).toHaveCount(2);
        await expect(cells.nth(0)).toHaveAttribute('data-value', '1');
        await expect(cells.nth(1)).toHaveAttribute('data-value', '2');
    });

    // ── queue ─────────────────────────────────────────────────────────────────────

    test('queue: cells show 7 and 8', async () => {
        const cells = page.locator('[data-testid="container-q"] [data-testid="container-cell"]');
        await expect(cells).toHaveCount(2);
        await expect(cells.nth(0)).toHaveAttribute('data-value', '7');
        await expect(cells.nth(1)).toHaveAttribute('data-value', '8');
    });

    test('queue: left arrow is visible', async () => {
        await expect(
            page.locator('[data-testid="container-q"]').getByText('←').first()
        ).toBeVisible();
    });

    // ── deque ─────────────────────────────────────────────────────────────────────

    test('deque: cells show 9 and 10', async () => {
        const cells = page.locator('[data-testid="container-dq"] [data-testid="container-cell"]');
        await expect(cells).toHaveCount(2);
        await expect(cells.nth(0)).toHaveAttribute('data-value', '9');
        await expect(cells.nth(1)).toHaveAttribute('data-value', '10');
    });

    test('deque: harr arrow is visible', async () => {
        await expect(
            page.locator('[data-testid="container-dq"]').getByText('↔').first()
        ).toBeVisible();
    });
});
