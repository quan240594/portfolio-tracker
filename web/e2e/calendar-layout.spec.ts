import { expect, test, type Locator, type Page } from '@playwright/test';

const events = (page: Page) => page.getByRole('region', { name: 'Events' });
const filters = (page: Page) => page.getByRole('region', { name: 'Calendar filters' });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function box(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return { top: rect!.y, bottom: rect!.y + rect!.height, left: rect!.x, right: rect!.x + rect!.width };
}

/** Page coordinates: the scroll position is added, so boxes measured after different scrolls compare. */
async function pageBox(page: Page, locator: Locator) {
  const rect = await box(locator);
  const scroll = await page.evaluate(() => window.scrollY);
  return { ...rect, top: rect.top + scroll, bottom: rect.bottom + scroll };
}

for (const width of [320, 1280]) {
  test.describe(`Calendar layout at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the income section comes first, then the filters with the colour key, then the calendar', async ({ page }) => {
      await page.goto('/calendar');
      await expect(page.getByTestId('calendar-income-chart')).toBeVisible();
      await expect(events(page).getByRole('listitem').or(events(page).getByRole('table')).first()).toBeVisible();

      const kpi = await pageBox(page, page.getByRole('region', { name: 'Annual income' }));
      const chart = await pageBox(page, page.getByTestId('calendar-income-chart'));
      const filterCard = await pageBox(page, filters(page));
      const calendarCard = await pageBox(page, events(page));

      expect(kpi.top).toBeLessThan(filterCard.top);
      expect(chart.bottom).toBeLessThanOrEqual(filterCard.top);
      expect(filterCard.bottom).toBeLessThanOrEqual(calendarCard.top);

      // The colour key and the download button belong to the filter card.
      const key = await pageBox(page, page.getByRole('list', { name: /Colours/ }));
      expect(key.top).toBeGreaterThanOrEqual(filterCard.top);
      expect(key.bottom).toBeLessThanOrEqual(filterCard.bottom);
      const download = await pageBox(page, page.getByRole('button', { name: 'Download .ics' }));
      expect(download.top).toBeGreaterThanOrEqual(filterCard.top);
      expect(download.bottom).toBeLessThanOrEqual(filterCard.bottom);

      expect(filterCard.right).toBeLessThanOrEqual(width);
      expect(calendarCard.right).toBeLessThanOrEqual(width);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('the tab order follows the new order: the filters, then the calendar controls', async ({ page }) => {
      await page.goto('/calendar');
      await expect(events(page).getByRole('listitem').or(events(page).getByRole('table')).first()).toBeVisible();
      const firstFilter = filters(page).getByRole('checkbox').first();
      await firstFilter.focus();
      await expect(firstFilter).toBeFocused();

      // Tab until the focus leaves the filter card: the next stop is inside the calendar card, never back in the income section.
      let leftFilters = false;
      for (let step = 0; step < 40 && !leftFilters; step++) {
        await page.keyboard.press('Tab');
        leftFilters = await page.evaluate(() => {
          const active = document.activeElement;
          return active !== null && !active.closest('section[aria-label="Calendar filters"]');
        });
      }
      expect(leftFilters).toBe(true);
      const inCalendar = await page.evaluate(() => document.activeElement?.closest('section[aria-label="Events"]') !== null);
      expect(inCalendar).toBe(true);
    });

    test('keeps the filters in the URL after the move', async ({ page }) => {
      await page.goto('/calendar?types=EARNINGS&status=ESTIMATED&scope=holdings');
      await expect(filters(page).getByRole('checkbox', { name: 'Earnings' })).toBeChecked();
      await expect(filters(page).getByRole('checkbox', { name: 'Ex-dividend' })).not.toBeChecked();
      await expect(filters(page).getByLabel('Show')).toHaveValue('holdings');
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
}
