import { test, expect, Page } from '@playwright/test';
import { runToBreakpoint, setupPage, waitForContainer } from './helpers';

let page: Page;

test.describe('linear containers', () => {
    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        await setupPage(page);
        await runToBreakpoint(page, '{v} {a} {s} {l}');   // 內部已登入並 goto('/edit')
        await waitForContainer(page, 'l');
    });

    test.afterAll(async () => {
        await page?.close();
    });

    // ── vector ───────────────────────────────────────────────────────────────────

    test('vector: cells show 10, 20, 30 in order', async () => {
        const cells = page.locator('[data-testid="container-v"] [data-testid="container-cell"]');
        await expect(cells).toHaveCount(3);
        await expect(cells.nth(0)).toHaveAttribute('data-value', '10');
        await expect(cells.nth(1)).toHaveAttribute('data-value', '20');
        await expect(cells.nth(2)).toHaveAttribute('data-value', '30');
    });

    test('vector: Size badge shows size 3', async () => {
        await expect(
            page.locator('[data-testid="container-v"]').getByText('size 3')
        ).toBeVisible();
    });

    // ── array ────────────────────────────────────────────────────────────────────

    // wasm engine gap: std::array parameter e2e_bp::a is never resolved (no container-a rendered)
    test.fixme('array: cells show 1, 2, 3 in order', async () => {
        const cells = page.locator('[data-testid="container-a"] [data-testid="container-cell"]');
        await expect(cells).toHaveCount(3);
        await expect(cells.nth(0)).toHaveAttribute('data-value', '1');
        await expect(cells.nth(1)).toHaveAttribute('data-value', '2');
        await expect(cells.nth(2)).toHaveAttribute('data-value', '3');
    });

    // ── string ───────────────────────────────────────────────────────────────────

    // wasm engine gap: std::string renders as raw 0x...: "hi" characters (21 cells) instead of 2 cells h,i
    test.fixme('string: cells show h and i', async () => {
        const cells = page.locator('[data-testid="container-s"] [data-testid="container-cell"]');
        await expect(cells).toHaveCount(2);
        await expect(cells.nth(0)).toHaveAttribute('data-value', 'h');
        await expect(cells.nth(1)).toHaveAttribute('data-value', 'i');
    });

    // ── list ─────────────────────────────────────────────────────────────────────

    test('list: nodes show 4, 5, 6', async () => {
        const cells = page.locator('[data-testid="container-l"] [data-testid="container-cell"]');
        await expect(cells).toHaveCount(3);
        await expect(cells.nth(0)).toHaveAttribute('data-value', '4');
        await expect(cells.nth(1)).toHaveAttribute('data-value', '5');
        await expect(cells.nth(2)).toHaveAttribute('data-value', '6');
    });

    test('list: harr separators are present between nodes', async () => {
        await expect(
            page.locator('[data-testid="container-l"]').getByText('↔').first()
        ).toBeVisible();
    });
});
