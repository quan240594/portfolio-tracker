import { expect, test } from '@playwright/test';

// The card grid starts at 1024 px (`lg`); the narrowest side-by-side widths must keep amounts on one line and the page free of sideways scrolling.
const WIDTHS = [1024, 1100, 1280];
// A six-figure amount: the longest realistic value of a KPI.
const LONG_AMOUNT = '€ 123.456,78';

for (const width of WIDTHS) {
  for (const url of ['/calendar', '/dividends']) {
    test(`KPI amounts stay on one line, inside their card: ${url} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const values = page.locator('[data-testid="kpi-value"], [data-testid="kpi-yield"], [data-testid="kpi-income"]');
      await expect(values.first()).toBeVisible();
      const report = await values.evaluateAll((elements, amount) => {
        const measure = (el: HTMLElement, text: string) => {
          el.textContent = text;
          const line = Number.parseFloat(getComputedStyle(el).lineHeight);
          return { lines: Math.round(el.getBoundingClientRect().height / line), overflow: el.scrollWidth > el.clientWidth + 1, width: Math.round(el.clientWidth) };
        };
        return elements.map((element) => {
          const el = element as HTMLElement;
          const original = el.textContent ?? '';
          const normal = measure(el, original);
          const long = measure(el, amount);
          el.textContent = original;
          return { original, normal, long };
        });
      }, LONG_AMOUNT);
      expect(report.length).toBeGreaterThan(0);
      for (const row of report) {
        expect(row.normal.lines, `${row.original} wraps`).toBe(1);
        expect(row.long.lines, `a six-figure amount wraps in ${row.long.width}px`).toBe(1);
        expect(row.long.overflow, 'a six-figure amount overflows').toBe(false);
      }
    });
  }
}

const GRID_PAGES = ['/dividends', '/calendar', '/rebalance?portfolio=trading-212', '/assets/AAPL?portfolio=all', '/analytics?tab=metrics', '/analytics?tab=dividends', '/analytics?tab=goal'];

for (const width of [1024, 1100]) {
  for (const url of GRID_PAGES) {
    test(`no sideways scrolling: ${url} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('[data-card-id]').first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
}
