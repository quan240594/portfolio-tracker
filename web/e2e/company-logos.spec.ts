import { expect, test, type Page } from '@playwright/test';

/**
 * Company logos in the calendar. The default mock server (the demo build) shows the neutral monogram and never calls /api/logos;
 * the second mock server of playwright.config.ts starts with VITE_LOGOS=on and serves a drawn stand-in for AAPL and KO through MSW
 * (404 for every other symbol), which covers the image path and its fallback in one page.
 */
// The second mock server of playwright.config.ts: one port above the first.
const LOGOS_ON = `http://localhost:${Number(process.env.E2E_PORT ?? 5174) + 1}`;

const events = (page: Page) => page.getByRole('region', { name: 'Events' });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const logoRequests = (page: Page): string[] => {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/logos/')) urls.push(request.url());
  });
  return urls;
};

for (const width of [320, 1280]) {
  test.describe(`Calendar logos at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the demo shows the monogram, asks for no logo and does not overflow', async ({ page }) => {
      const requested = logoRequests(page);
      await page.goto('/calendar?range=year');
      if (width >= 640) await page.getByRole('radio', { name: 'List' }).locator('xpath=ancestor::label').click();
      const rows = events(page).getByRole('listitem');
      await expect(rows.first()).toBeVisible();
      await expect(events(page).locator('img')).toHaveCount(0);
      const monograms = events(page).locator('[data-logo="monogram"]');
      expect(await monograms.count()).toBeGreaterThan(2);
      await expect(monograms.first().locator('[data-monogram]')).toHaveAttribute('data-monogram', /^[A-Z0-9]{1,2}$/);
      // The type is still told apart without the letter badge: a marker, the words and the accessible name.
      const first = rows.first().getByRole('button');
      await expect(first).toHaveAccessibleName(/^[^,]+, (Ex-dividend|Dividend payment|Earnings|Stock split|Corporate action), /);
      await expect(first.locator('svg[data-shape]')).toHaveCount(1);
      expect(requested).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('with logos on, a known symbol shows its image, the others the monogram, and nothing overflows', async ({ page }) => {
      await page.goto(`${LOGOS_ON}/calendar?range=year`);
      if (width >= 640) await page.getByRole('radio', { name: 'List' }).locator('xpath=ancestor::label').click();
      const apple = events(page).getByRole('button', { name: /^AAPL,/ }).first();
      await expect(apple).toBeVisible();
      await apple.scrollIntoViewIfNeeded();
      const image = apple.locator('img');
      await expect(image).toHaveAttribute('src', '/api/logos/AAPL');
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      await expect(image).toHaveAttribute('alt', '');

      // MSFT has no stand-in (404): once its image fails the row falls back to the monogram, in a box of the same size.
      const microsoft = events(page).getByRole('button', { name: /^MSFT,/ }).first();
      await microsoft.scrollIntoViewIfNeeded();
      await expect(microsoft.locator('[data-logo="monogram"] [data-monogram]')).toHaveAttribute('data-monogram', 'MS');
      await expect(microsoft.locator('img')).toHaveCount(0);
      const sizes = await Promise.all([apple, microsoft].map((row) => row.locator('[data-logo]').first().evaluate((box) => `${box.getBoundingClientRect().width}x${box.getBoundingClientRect().height}`)));
      expect(sizes[0]).toBe(sizes[1]);

      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
}

test.describe('Calendar month grid with logos', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('shows the logo image on a chip next to the symbol and keeps the type in its name', async ({ page }) => {
    await page.goto(`${LOGOS_ON}/calendar`);
    const grid = events(page).getByRole('table');
    await expect(grid).toBeVisible();
    const chips = grid.getByRole('button', { name: /^(AAPL|KO),/ });
    if ((await chips.count()) === 0) await page.getByRole('button', { name: 'Next month' }).click();
    const chip = chips.first();
    await expect(chip).toBeVisible();
    await expect(chip.locator('img')).toHaveAttribute('src', /\/api\/logos\/(AAPL|KO)$/);
    await expect(chip).toHaveAccessibleName(/(Ex-dividend|Dividend payment|Earnings|Stock split|Corporate action)/);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
