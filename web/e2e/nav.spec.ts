import { expect, test, type Page } from '@playwright/test';
import { gotoViaNav, mainNav, openPortfolioMenu, portfolioTrigger } from './nav';

const MENU_LABELS = ['Holdings', 'Transactions', 'Dividends', 'Rebalance', 'Assets', 'Watchlist', 'Goals', 'Calendar', 'Brokers'];

/** True when the page itself (not an inner scroller) scrolls horizontally. */
const pageOverflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

test.describe('Header navigation (mock mode)', () => {
  test('groups the pages and opens/closes the Portfolio menu', async ({ page }) => {
    await page.goto('/');
    const nav = mainNav(page);
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Analytics' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Holdings' })).toBeHidden();

    const trigger = portfolioTrigger(page);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.getByRole('listitem').getByRole('link')).toHaveText(['Dashboard', ...MENU_LABELS, 'Analytics']);
    for (const label of MENU_LABELS) await expect(nav.getByRole('link', { name: label })).toBeVisible();

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.getByRole('link', { name: 'Holdings' })).toBeHidden();
  });

  test('keyboard: Enter opens, Tab walks the links, Escape closes and refocuses the trigger', async ({ page }) => {
    await page.goto('/');
    const trigger = portfolioTrigger(page);
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    for (const label of MENU_LABELS.slice(0, 3)) {
      await page.keyboard.press('Tab');
      await expect(mainNav(page).getByRole('link', { name: label })).toBeFocused();
    }
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Space');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/holdings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Holdings' })).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('closes on an outside click and when focus leaves the menu', async ({ page }) => {
    await page.goto('/');
    const trigger = await openPortfolioMenu(page);
    await page.getByRole('heading', { level: 1 }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await openPortfolioMenu(page);
    await mainNav(page).getByRole('link', { name: 'Brokers' }).focus();
    await page.keyboard.press('Tab');
    await expect(mainNav(page).getByRole('link', { name: 'Analytics' })).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('marks the Portfolio trigger and the child active, also on nested routes', async ({ page }) => {
    await page.goto('/');
    await expect(portfolioTrigger(page)).not.toHaveAttribute('data-active', 'true');
    await gotoViaNav(page, 'Transactions');
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible();
    await expect(portfolioTrigger(page)).toHaveAttribute('data-active', 'true');
    await openPortfolioMenu(page);
    await expect(mainNav(page).getByRole('link', { name: 'Transactions' })).toHaveAttribute('aria-current', 'page');

    await page.goto('/assets/AAPL');
    await expect(portfolioTrigger(page)).toHaveAttribute('data-active', 'true');

    await gotoViaNav(page, 'Analytics');
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(portfolioTrigger(page)).not.toHaveAttribute('data-active', 'true');
  });

  for (const width of [390, 320]) {
    test(`never scrolls the page horizontally at ${width}px, menu closed or open`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/');
      // The dashboard is fully loaded (movers, watchlist, charts) so late content cannot widen the page unnoticed.
      await expect(page.getByRole('heading', { name: 'Top day gainers' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Watchlist' }).getByRole('table')).toBeVisible();
      expect(await pageOverflows(page)).toBe(false);

      await openPortfolioMenu(page);
      expect(await pageOverflows(page)).toBe(false);

      // Everything is reachable and comfortably tappable (≥44px) without sideways scrolling.
      for (const label of MENU_LABELS) {
        const box = await mainNav(page).getByRole('link', { name: label }).boundingBox();
        expect(box, label).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      const trigger = await portfolioTrigger(page).boundingBox();
      expect(trigger!.height).toBeGreaterThanOrEqual(44);

      await gotoViaNav(page, 'Holdings');
      await expect(page.getByRole('heading', { level: 1, name: 'Holdings' })).toBeVisible();
      expect(await pageOverflows(page)).toBe(false);
    });
  }
});
