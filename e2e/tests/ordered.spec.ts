import { test, expect, Page } from '@playwright/test';
import { runToBreakpoint, enableBSTMode, setupPage, waitForContainer } from './helpers';

let page: Page;

test.describe('ordered containers', () => {
    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        await setupPage(page);
        await page.goto('/');
        await runToBreakpoint(page, '{se} {ms} {m} {mm}');
        await waitForContainer(page, 'mm');
    });

    test.afterAll(async () => {
        await page?.close();
    });

    // ── set ───────────────────────────────────────────────────────────────────────

    test('set: cells show 3, 5, 7 (sorted order)', async () => {
        const cells = page.locator('[data-testid="container-se"] [data-testid="container-cell"]');
        await expect(cells).toHaveCount(3);
        await expect(cells.nth(0)).toHaveAttribute('data-value', '3');
        await expect(cells.nth(1)).toHaveAttribute('data-value', '5');
        await expect(cells.nth(2)).toHaveAttribute('data-value', '7');
    });

    test('set: BST mode renders SVG tree with 3 nodes', async () => {
        await enableBSTMode(page, 'se');
        const nodes = page.locator('[data-testid="container-se"] [data-testid="bst-node"]');
        await expect(nodes).toHaveCount(3);
    });

    test('set: BST nodes carry correct data-key attributes', async () => {
        await enableBSTMode(page, 'se');
        const wrapper = page.locator('[data-testid="container-se"]');
        await expect(wrapper.locator('[data-testid="bst-node"][data-key="3"]')).toBeVisible();
        await expect(wrapper.locator('[data-testid="bst-node"][data-key="5"]')).toBeVisible();
        await expect(wrapper.locator('[data-testid="bst-node"][data-key="7"]')).toBeVisible();
    });

    // ── multiset ──────────────────────────────────────────────────────────────────

    test('multiset: cells show 2, 2, 4 (sorted, duplicates allowed)', async () => {
        const cells = page.locator('[data-testid="container-ms"] [data-testid="container-cell"]');
        await expect(cells).toHaveCount(3);
        await expect(cells.nth(0)).toHaveAttribute('data-value', '2');
        await expect(cells.nth(1)).toHaveAttribute('data-value', '2');
        await expect(cells.nth(2)).toHaveAttribute('data-value', '4');
    });

    test('multiset: BST mode renders SVG tree with 3 nodes', async () => {
        await enableBSTMode(page, 'ms');
        const nodes = page.locator('[data-testid="container-ms"] [data-testid="bst-node"]');
        await expect(nodes).toHaveCount(3);
    });

    // ── map ───────────────────────────────────────────────────────────────────────

    test('map: rows show key=1 value=a and key=2 value=b', async () => {
        const rows = page.locator('[data-testid="container-m"] [data-testid="container-row"]');
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toHaveAttribute('data-key', '1');
        await expect(rows.nth(0)).toHaveAttribute('data-value', 'a');
        await expect(rows.nth(1)).toHaveAttribute('data-key', '2');
        await expect(rows.nth(1)).toHaveAttribute('data-value', 'b');
    });

    test('map: BST mode renders SVG tree with 2 nodes', async () => {
        await enableBSTMode(page, 'm');
        const nodes = page.locator('[data-testid="container-m"] [data-testid="bst-node"]');
        await expect(nodes).toHaveCount(2);
    });

    // ── multimap ──────────────────────────────────────────────────────────────────

    test('multimap: rows show both key=1 entries plus their values', async () => {
        const rows = page.locator('[data-testid="container-mm"] [data-testid="container-row"]');
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toHaveAttribute('data-key', '1');
        await expect(rows.nth(0)).toHaveAttribute('data-value', 'x');
        await expect(rows.nth(1)).toHaveAttribute('data-key', '1');
        await expect(rows.nth(1)).toHaveAttribute('data-value', 'y');
    });

    test('multimap: BST mode renders SVG tree', async () => {
        await enableBSTMode(page, 'mm');
        await expect(
            page.locator('[data-testid="container-mm"] [data-testid="bst-svg"]')
        ).toBeVisible();
    });
});
