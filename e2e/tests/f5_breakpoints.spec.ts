import { test, expect } from '@playwright/test';
import { setupPage } from './helpers';

const CODE = `#include <iostream>
using namespace std;
int main() {
    int sum = 0;
    for (int i = 0; i < 5; i++) {
        sum += i;
        cout << i << endl;
    }
    cout << sum << endl;
    return 0;
}
`;

const bkptLines = (page: any): Promise<number[]> => page.evaluate(() =>
    Array.from(new Set(
        ((window as any).store.get('breakpoints') as any[])
            .filter(b => b.is_normal_breakpoint !== false && !b.is_child_breakpoint && !b.is_parent_breakpoint)
            .map(b => parseInt(b.line))
    )).sort((a: number, b: number) => a - b)
);

/**
 * Regression: breakpoints must survive an F5 reload.
 * Type real code, set breakpoints, run, then reload and confirm they are still
 * there. (gdb's own pending e2e_bp at line 26 is ignored via a subset check.)
 */
test('breakpoints survive F5 after typing + running real code', async ({ page }) => {
    await setupPage(page);
    await page.goto('/');
    await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 15_000 });
    await page.waitForSelector('.monaco-editor textarea', { timeout: 15_000 });

    await page.locator('.monaco-editor textarea').first().click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText(CODE);
    await page.waitForTimeout(800);

    // Play mode so the guide drag-handles stop covering the line-number gutter.
    await page.evaluate(() => (window as any).store.set('edit_mode', false));

    const mine = [6, 7, 9];
    for (const ln of mine) {
        await page.locator('.monaco-editor .margin-view-overlays .line-numbers')
            .filter({ hasText: new RegExp(`^${ln}$`) }).first().click();
    }
    await page.waitForTimeout(500);
    const set = await bkptLines(page);
    expect(mine.every(l => set.includes(l))).toBe(true);

    await page.click('#run_button');
    await page.waitForFunction(
        () => ['paused', 'exited'].includes((window as any).store.get('inferior_program')),
        null, { timeout: 30_000 });
    await page.waitForTimeout(1500);

    await page.reload();
    await page.waitForFunction(() => (window as any).store !== undefined, null, { timeout: 15_000 });
    await page.waitForTimeout(2500);

    const after = await bkptLines(page);
    expect(mine.every(l => after.includes(l))).toBe(true);
});
