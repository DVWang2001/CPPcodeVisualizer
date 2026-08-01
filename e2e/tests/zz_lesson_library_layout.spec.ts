import { test, expect } from '@playwright/test';
import { ensureLoggedIn } from './helpers';

test('the library workbench exposes its account, search, and desktop columns', async ({ page }) => {
  await ensureLoggedIn(page);
  await page.goto('/');

  await expect(page.getByTestId('account-nav-profile')).toBeVisible();
  await expect(page.getByTestId('lesson-browse-search')).toBeVisible();
  await expect(page.getByTestId('lesson-browse-columns')).toBeVisible();
});

test('the library workbench does not overflow a phone viewport', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await ensureLoggedIn(page);
  await page.goto('/');

  await expect(page.getByTestId('account-nav-profile')).toBeVisible();
  await expect(page.getByTestId('lesson-browse-search')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.close();
});
