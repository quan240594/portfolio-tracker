import { expect, test, type Locator, type Page } from '@playwright/test';

/** Include / exclude of series and rows through the legend and the data table of the Growth tab and the asset detail charts (mock mode). */

test.beforeEach(async ({ page }) => {
  // the demo is relative to "today": a fixed clock makes it reproducible
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
});

const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const lines = (chart: Locator) => chart.locator('path.recharts-line-curve');
const barGroups = (chart: Locator) => chart.locator('.recharts-bar');
const bars = (chart: Locator) => chart.locator('.recharts-bar-rectangle');
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const toggle = (scope: Locator, name: string | RegExp) => scope.getByRole('button', { name, exact: typeof name === 'string' });

test.describe('Growth tab', () => {
  test('Portfolio value: a legend entry or a table header hides a series; the headline and the benchmark picker do not change', async ({ page }) => {
    await page.goto('/analytics');
    const region = card(page, 'Portfolio value');
    const chart = region.getByTestId('growth-value-chart');
    const legend = region.getByTestId('growth-value-legend');
    await expect(lines(chart).first()).toBeVisible();
    const all = await lines(chart).count();
    expect(all).toBe(2);
    const headline = page.getByText(/^Your portfolio is (ahead of|behind) IWDA\.AS by/);
    const text = await headline.textContent();

    await expect(toggle(legend, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'true');
    await toggle(legend, /^IWDA\.AS/).click();
    await expect(toggle(legend, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'false');
    await expect(lines(chart)).toHaveCount(all - 1);
    await expect(region.getByTestId('selection-note')).toHaveText('Chart shows the current selection');
    await expect(headline).toHaveText(text!);
    await expect(card(page, 'Benchmarks').getByRole('list', { name: 'Selected benchmarks' }).getByRole('listitem')).toHaveCount(1);

    // the data table shows the same state; its date rows are plain headers, the series columns are toggles
    await region.getByRole('button', { name: 'Data table' }).click();
    const table = region.getByRole('table', { name: 'Portfolio value over time' });
    await expect(toggle(table, 'IWDA.AS')).toHaveAttribute('aria-pressed', 'false');
    await expect(table.getByRole('rowheader').first().getByRole('button')).toHaveCount(0);
    await toggle(table, 'Invested').click();
    await expect(toggle(legend, /^Invested/)).toHaveAttribute('aria-pressed', 'false');
    await region.getByRole('button', { name: 'Data table' }).click();
    await expect(lines(chart)).toHaveCount(0);
    await expect(chart.locator('path.recharts-area-area')).toBeVisible();

    // the last series goes: an empty state, which offers to undo it
    await toggle(legend, /^Portfolio/).click();
    await expect(region.getByTestId('nothing-selected')).toHaveText('Nothing selected: show all');
    await expect(chart).toHaveCount(0);
    await region.getByTestId('nothing-selected').getByRole('button', { name: 'show all' }).click();
    await expect(lines(chart)).toHaveCount(all);
    await expect(toggle(legend, /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'true');
    await expect(region.getByTestId('selection-note')).toHaveCount(0);
  });

  test('Portfolio performance: Show all in the legend resets', async ({ page }) => {
    await page.goto('/analytics');
    const region = card(page, 'Portfolio performance');
    const chart = region.getByTestId('growth-performance-chart');
    const legend = region.getByTestId('growth-performance-legend');
    await expect(lines(chart).first()).toBeVisible();
    await toggle(legend, /^Portfolio/).click();
    await expect(lines(chart)).toHaveCount(1);
    await expect(chart).toHaveAccessibleName(/current selection: IWDA\.AS\.$/);
    await legend.getByRole('button', { name: 'Show all' }).click();
    await expect(lines(chart)).toHaveCount(2);
    await expect(toggle(legend, /^Portfolio/)).toHaveAttribute('aria-pressed', 'true');
  });

  test('Dynamics: a month row and a series can be excluded from the details table', async ({ page }) => {
    await page.goto('/analytics');
    const region = card(page, 'Dynamics of portfolio returns');
    const chart = region.getByTestId('growth-dynamics-chart');
    await expect(bars(chart).first()).toBeVisible();
    const all = await bars(chart).count();
    await region.getByRole('button', { name: 'View details' }).click();
    const table = region.getByRole('table', { name: 'Monthly returns, newest first' });
    await expect(table).toHaveAccessibleDescription('Click a column or row header to include or exclude it from the chart');

    await table.getByRole('rowheader').first().getByRole('button').click();
    await expect(bars(chart)).toHaveCount(all - 2);
    await expect(table.getByRole('rowheader').first().getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    await toggle(table, 'IWDA.AS').click();
    await expect(barGroups(chart)).toHaveCount(1);
    await expect(toggle(region.getByTestId('growth-dynamics-legend'), /^IWDA\.AS/)).toHaveAttribute('aria-pressed', 'false');
    await region.getByTestId('growth-dynamics-legend').getByRole('button', { name: 'Show all' }).click();
    await expect(bars(chart)).toHaveCount(all);
    await expect(barGroups(chart)).toHaveCount(2);
  });

  test('Holdings: a row header leaves one holding out of the bars', async ({ page }) => {
    await page.goto('/analytics');
    const region = card(page, 'Holdings performance');
    const chart = region.getByTestId('growth-holdings-chart');
    await expect(bars(chart).first()).toBeVisible();
    const all = await bars(chart).count();
    await region.getByRole('radio', { name: 'Table' }).click();
    const table = region.getByRole('table', { name: 'Return per holding, best first' });
    await table.getByRole('rowheader').first().getByRole('button').click();
    await region.getByRole('radio', { name: 'Bars' }).click();
    await expect(bars(chart)).toHaveCount(all - 1);
    await toggle(region.getByTestId('growth-holdings-legend'), /^Return per holding/).click();
    await expect(region.getByTestId('nothing-selected')).toBeVisible();
    await region.getByTestId('nothing-selected').getByRole('button', { name: 'show all' }).click();
    await expect(bars(chart)).toHaveCount(all);
  });
});

test.describe('Asset detail', () => {
  test('Price history: the benchmark line leaves the chart and the table, the trade markers go with the security line', async ({ page }) => {
    await page.goto('/assets/ASML.AS?portfolio=all');
    const region = card(page, 'Price history');
    const chart = region.getByTestId('asset-price-chart');
    const legend = region.getByTestId('asset-price-legend');
    await expect(lines(chart).first()).toBeVisible();
    await expect(lines(chart)).toHaveCount(2);

    await toggle(legend, /^IWDA\.AS/).click();
    await expect(lines(chart)).toHaveCount(1);
    await expect(chart).toHaveAccessibleName(/current selection: ASML\.AS\.$/);
    await region.getByRole('button', { name: 'Data table' }).click();
    const table = region.getByRole('table', { name: 'ASML.AS price change over time' });
    await expect(toggle(table, 'IWDA.AS')).toHaveAttribute('aria-pressed', 'false');
    await toggle(table, 'ASML.AS').click();
    await expect(region.getByRole('list', { name: 'Trade markers' })).toHaveCount(0);
    await region.getByRole('button', { name: 'Data table' }).click();
    await expect(region.getByTestId('nothing-selected')).toBeVisible();
    await region.getByTestId('nothing-selected').getByRole('button', { name: 'show all' }).click();
    await expect(lines(chart)).toHaveCount(2);
    await expect(region.getByRole('list', { name: 'Trade markers' })).toBeVisible();
  });

  test('Dividends per year: a kind of year and a year row can be excluded', async ({ page }) => {
    await page.goto('/assets/AAPL?portfolio=all&tab=dividends');
    const region = card(page, 'Dividend per share per year');
    const chart = region.getByTestId('asset-dividend-chart');
    const legend = region.getByTestId('asset-dividend-legend');
    const years = chart.locator('.recharts-xAxis .recharts-cartesian-axis-tick-value');
    await expect(years.first()).toBeVisible();
    const all = await years.count();
    expect(all).toBeGreaterThan(1);

    await toggle(legend, 'Partial year').click();
    await expect(toggle(legend, 'Partial year')).toHaveAttribute('aria-pressed', 'false');
    await expect(years).toHaveCount(1);
    await region.getByRole('button', { name: 'Data table' }).click();
    const table = region.getByRole('table', { name: 'Dividend per share of AAPL per year' });
    await expect(toggle(table, 'Partial year')).toHaveAttribute('aria-pressed', 'false');
    await region.getByRole('button', { name: 'Show all' }).first().click();
    await table.getByRole('rowheader').first().getByRole('button').click();
    await region.getByRole('button', { name: 'Data table' }).click();
    await expect(years).toHaveCount(all - 1);
  });
});

test.describe('Layout with excluded entries', () => {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
    [320, 700],
  ] as const) {
    test(`the Growth tab and the asset detail never scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/analytics');
      await expect(page.getByTestId('growth-holdings-chart')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      for (const [name, legend] of [
        ['Portfolio value', 'growth-value-legend'],
        ['Portfolio performance', 'growth-performance-legend'],
        ['Dynamics of portfolio returns', 'growth-dynamics-legend'],
      ] as const) {
        await toggle(card(page, name).getByTestId(legend), /^IWDA\.AS/).click();
      }
      for (const name of ['Portfolio value', 'Portfolio performance']) await card(page, name).getByRole('button', { name: 'Data table' }).click();
      await card(page, 'Dynamics of portfolio returns').getByRole('button', { name: 'View details' }).click();
      await card(page, 'Holdings performance').getByRole('radio', { name: 'Table' }).click();
      await card(page, 'Holdings performance').getByRole('table').getByRole('rowheader').first().getByRole('button').click();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      for (const region of await page.getByRole('region').all()) {
        const box = await region.boundingBox();
        if (box) expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      }

      // the asset header can already be a few pixels wider than a 320px phone (its price change does not wrap): compare with the page before the exclusions
      await page.goto('/assets/AAPL?portfolio=all');
      await expect(page.getByTestId('asset-price-chart')).toBeVisible();
      const priceBefore = await overflow(page);
      await toggle(page.getByTestId('asset-price-legend'), /^IWDA\.AS/).click();
      await card(page, 'Price history').getByRole('button', { name: 'Data table' }).click();
      expect(await overflow(page)).toBeLessThanOrEqual(priceBefore);
      const priceBox = await card(page, 'Price history').boundingBox();
      expect(priceBox!.x + priceBox!.width).toBeLessThanOrEqual(width + 1);
      await page.goto('/assets/AAPL?portfolio=all&tab=dividends');
      await expect(page.getByTestId('asset-dividend-chart')).toBeVisible();
      const dividendsBefore = await overflow(page);
      await toggle(page.getByTestId('asset-dividend-legend'), 'Partial year').click();
      await card(page, 'Dividend per share per year').getByRole('button', { name: 'Data table' }).click();
      expect(await overflow(page)).toBeLessThanOrEqual(dividendsBefore);
      const box = await card(page, 'Dividend per share per year').boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    });
  }
});
