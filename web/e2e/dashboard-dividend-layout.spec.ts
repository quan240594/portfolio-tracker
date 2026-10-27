import { expect, test, type Locator, type Page } from '@playwright/test';

// The demo is relative to "today"; a fixed clock makes its figures reproducible.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
});

const VIEWPORTS = [
  { width: 320, height: 700 },
  { width: 1280, height: 900 },
  { width: 1600, height: 1000 },
] as const;

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
}

const region = (scope: Page | Locator, name: string) => scope.getByRole('region', { name, exact: true });

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const STANDARD_CARDS = [
  'Total value',
  'Day change',
  'Unrealized P&L',
  'Currency effect',
  'Total return',
  'Dividends received',
  'Realized P&L',
  'Money-weighted return (IRR)',
  'Time-weighted return (TWR)',
  'Dividend yield (TTM)',
  'Dividend growth (TTM)',
  'Passive income (next 12 months)',
];

test.describe('Dashboard stat grid (mock mode)', () => {
  for (const { width, height } of VIEWPORTS) {
    test(`lays out the twelve cards without overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      const grid = page.getByTestId('kpi-grid');
      await expect(region(page, 'Dividend yield (TTM)').getByTestId('kpi-value')).toHaveText(/^\d+,\d{2}%$/);
      await expect(region(page, 'Passive income (next 12 months)').getByTestId('kpi-value')).toHaveText(/^€\s[\d.]+,\d{2}$/);
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      const boxes: (Box & { name: string })[] = [];
      for (const name of STANDARD_CARDS) boxes.push({ name, ...(await box(region(grid, name))) });
      const frame = await box(grid);
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(frame.x - 1);
        expect(b.x + b.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
      }
      const rows = [...new Set(boxes.map((b) => Math.round(b.y)))];
      const perRow = (y: number) => boxes.filter((b) => Math.round(b.y) === y).length;
      if (width === 320) {
        expect(rows).toHaveLength(12);
        for (const b of boxes) expect(Math.abs(b.width - frame.width)).toBeLessThanOrEqual(1);
      } else {
        expect(rows).toHaveLength(4);
        for (const y of rows) expect(perRow(y)).toBe(3);
        // the last row is the trailing dividend pair and the forward income
        const last = boxes.filter((b) => Math.round(b.y) === rows.at(-1));
        expect(last.map((b) => b.name)).toEqual(['Dividend yield (TTM)', 'Dividend growth (TTM)', 'Passive income (next 12 months)']);
        for (const b of boxes) expect(Math.abs(b.width - boxes[0]!.width)).toBeLessThanOrEqual(1);
      }
    });
  }

  test('uses two columns on a tablet', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto('/');
    await expect(region(page, 'Dividend growth (TTM)').getByTestId('kpi-value')).toBeVisible();
    const boxes: Box[] = [];
    for (const name of STANDARD_CARDS) boxes.push(await box(region(page.getByTestId('kpi-grid'), name)));
    expect(new Set(boxes.map((b) => Math.round(b.x))).size).toBe(2);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('the info tips explain the trailing figures and stay on screen at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/');
    for (const name of ['Dividend yield (TTM)', 'Dividend growth (TTM)']) {
      const card = region(page, name);
      await expect(card.getByTestId('kpi-value')).toBeVisible();
      await card.getByLabel(`About ${name}`).click();
      const tip = card.getByText(/TTM means trailing twelve months/);
      await expect(tip).toBeVisible();
      const b = await box(tip);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(320);
      await card.getByLabel(`About ${name}`).click();
    }
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('shows the trailing yield on cost and a signed growth or n/a with a reason', async ({ page }) => {
    await page.goto('/');
    const yieldCard = region(page, 'Dividend yield (TTM)');
    await expect(yieldCard).toContainText(/\d+,\d{2}% on cost/);
    await expect(yieldCard).toContainText(/Trailing 12 months, \d+ dividend-paying holdings?|No dividends received in the last 12 months/);
    const growth = region(page, 'Dividend growth (TTM)');
    await expect(growth.getByTestId('kpi-value')).toHaveText(/[+−]\d+,\d%$|^n\/a$/);
  });
});

test.describe('Dividends page layout (mock mode)', () => {
  for (const { width, height } of VIEWPORTS) {
    test(`Dividends received comes first and spans the content width at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/dividends');
      const received = region(page, 'Dividends received');
      await expect(received.getByTestId('received-time-chart')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      const growth = await box(region(page, 'Dividend growth'));
      const r = await box(received);
      const byHolding = await box(region(page, 'Dividends received by holding'));
      const future = await box(region(page, 'Future payments'));
      const average = await box(region(page, 'Average annual growth'));

      // the same width as the full-width Dividend growth card
      expect(Math.abs(r.width - growth.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(r.x - growth.x)).toBeLessThanOrEqual(1);
      // Average annual growth no longer sits above Dividends received: everything else follows it
      for (const other of [byHolding, future, average]) expect(other.y).toBeGreaterThanOrEqual(r.y + r.height - 1);
      expect(average.y).toBeGreaterThan(byHolding.y);
      expect(average.y).toBeGreaterThan(future.y);

      if (width > 320) {
        // row 2 holds two half-width cards side by side, Average annual growth has its own full-width row
        expect(Math.abs(byHolding.y - future.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(byHolding.width - future.width)).toBeLessThanOrEqual(1);
        expect(byHolding.width).toBeLessThan(r.width * 0.55);
        expect(Math.abs(average.width - r.width)).toBeLessThanOrEqual(1);
      } else {
        for (const other of [byHolding, future, average]) expect(Math.abs(other.width - r.width)).toBeLessThanOrEqual(1);
      }
    });
  }

  test('shows every month of the 12-month view with the future payments without a horizontal scroll at 1600px', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto('/dividends');
    await region(page, 'Dividends received').getByRole('radio', { name: '12 months' }).click();
    const chart = region(page, 'Dividends received').getByTestId('received-time-chart');
    await expect(chart).toBeVisible();
    const scrolls = await chart.evaluate((el) => (el.parentElement ? el.parentElement.scrollWidth - el.parentElement.clientWidth : 0));
    expect(scrolls).toBeLessThanOrEqual(1);
  });
});

test.describe('Dividend growth card spacing (mock mode)', () => {
  const growth = (page: Page) => region(page, 'Dividend growth');

  for (const { width, height } of VIEWPORTS) {
    test(`separates the summary items, the legend and the chart at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/dividends');
      const card = growth(page);
      const summary = card.getByTestId('forecast-summary');
      await expect(summary).toBeVisible();
      await expect(card.getByTestId('year-compare-chart')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      const items: Box[] = [];
      for (const key of ['forecast', 'declared', 'estimated', 'trend']) items.push(await box(card.getByTestId(`forecast-summary-${key}`)));
      for (const [i, a] of items.entries()) {
        for (const b of items.slice(i + 1)) {
          const apart = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height));
          expect(apart).toBeGreaterThanOrEqual(16);
        }
      }

      const summaryBox = await box(summary);
      const legend = await box(card.getByTestId('growth-legend'));
      const chart = await box(card.getByTestId('year-compare-chart'));
      expect(legend.y - (summaryBox.y + summaryBox.height)).toBeGreaterThanOrEqual(16);
      expect(chart.y - (legend.y + legend.height)).toBeGreaterThanOrEqual(16);
      expect(chart.height).toBeGreaterThanOrEqual(320);
      // the long explanation is behind a disclosure, not between the legend and the chart
      await expect(card.getByTestId('growth-legend-note')).toBeHidden();
    });
  }

  test('keeps the legend in one row with wide gaps at 1600px', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto('/dividends');
    const legend = growth(page).getByTestId('growth-legend');
    await expect(legend.getByRole('button', { name: 'Estimated (from history)' })).toBeVisible();
    await expect(legend.getByRole('button', { name: 'Average of years' })).toBeVisible();
    // one evaluation: the page may still shift while the forecast loads, so all rectangles are read at the same moment
    const boxes: Box[] = await legend.evaluate((el) =>
      [...el.querySelectorAll('button')].map((b) => {
        const r = b.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    expect(boxes.length).toBeGreaterThanOrEqual(6);
    for (const b of boxes) expect(Math.abs(b.y - boxes[0]!.y)).toBeLessThanOrEqual(1);
    for (const [i, b] of boxes.slice(1).entries()) expect(b.x - (boxes[i]!.x + boxes[i]!.width)).toBeGreaterThanOrEqual(12);
  });

  test('draws the average of the years as a thin line without markers', async ({ page }) => {
    await page.goto('/dividends');
    const chart = growth(page).getByTestId('year-compare-chart');
    await expect(chart).toBeVisible();
    const line = chart.locator('path.recharts-line-curve').first();
    await expect(line).toHaveAttribute('stroke-width', '1.25');
    await expect(chart.locator('.recharts-line-dots circle')).toHaveCount(0);
  });
});
