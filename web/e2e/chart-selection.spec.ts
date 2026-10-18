import { expect, test, type Locator, type Page } from '@playwright/test';
import { settledCount } from './settled';

/** Include / exclude of series and rows through the legend and the data table of the Dividends charts (mock mode). */

test.beforeEach(async ({ page }) => {
  // the demo is relative to "today": a fixed clock makes it reproducible
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
});

const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const bars = (chart: Locator) => chart.locator('path.recharts-rectangle');
const slices = (chart: Locator) => chart.locator('path.recharts-sector');
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const toggle = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });

async function openTable(region: Locator, name: string): Promise<Locator> {
  await region.getByText('Show data table').click();
  const table = region.getByRole('table', { name });
  await expect(table).toBeVisible();
  return table;
}

test.describe('Yield / payout', () => {
  test('a legend entry hides its series, the table header and the legend stay in sync, Show all resets', async ({ page }) => {
    await page.goto('/dividends');
    const region = card(page, 'Yield / payout');
    const chart = region.getByTestId('yield-payout-chart');
    const legend = region.getByTestId('yield-payout-legend');
    await expect(bars(chart).first()).toBeVisible();
    const all = await settledCount(bars(chart));
    const dots = chart.locator('circle.recharts-dot');
    expect(await dots.count()).toBeGreaterThan(0);

    const table = await openTable(region, 'Dividend yield and forward annual amount');
    await expect(toggle(legend, 'Yield on cost')).toHaveAttribute('aria-pressed', 'true');
    await toggle(legend, 'Yield on cost').click();
    await expect(toggle(legend, 'Yield on cost')).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle(table, 'Yield on cost')).toHaveAttribute('aria-pressed', 'false');
    await expect(dots).toHaveCount(0);
    await expect(bars(chart)).toHaveCount(all);
    await expect(region.getByTestId('selection-note')).toHaveText('Chart shows the current selection');

    // a row header of the table leaves one holding out of the chart
    await table.getByRole('rowheader').first().getByRole('button').click();
    await expect(bars(chart)).toHaveCount(all - 1);

    // the last series goes: an empty state instead of an empty chart
    await toggle(legend, 'Yield on value').click();
    await expect(region.getByTestId('nothing-selected')).toHaveText('Nothing selected: show all');
    await expect(chart).toHaveCount(0);
    await region.getByTestId('nothing-selected').getByRole('button', { name: 'show all' }).click();
    await expect(bars(chart)).toHaveCount(all);
    await expect(dots.first()).toBeVisible();
    await expect(toggle(legend, 'Yield on cost')).toHaveAttribute('aria-pressed', 'true');
    await expect(region.getByTestId('selection-note')).toHaveCount(0);
  });
});

test.describe('Donuts', () => {
  test('a legend entry or a table row removes a slice and the total in the middle is recomputed', async ({ page }) => {
    await page.goto('/dividends');
    const region = card(page, 'Passive income diversification');
    const donut = region.getByTestId('income-donut');
    const legend = region.getByTestId('income-legend');
    await expect(slices(donut).first()).toBeVisible();
    const all = await settledCount(slices(donut));
    const centre = region.getByTestId('income-donut-centre');
    const before = await centre.textContent();

    const first = legend.getByRole('button').first();
    const name = (await first.textContent())!;
    await first.click();
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await expect(slices(donut)).toHaveCount(all - 1);
    await expect(centre).not.toHaveText(before!);
    await expect(region.getByRole('list', { name: 'Holdings ranked by expected annual income' }).getByRole('listitem')).toHaveCount(all - 1);

    const table = await openTable(region, 'Forward annual dividend income by holding');
    const row = table.getByRole('row').nth(1);
    await expect(row.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    await expect(row.getByRole('cell').first()).toHaveText('—');
    // the shares of the slices that are left add up to 100%
    const shares = await table.locator('tbody tr td:first-of-type').allTextContents();
    const total = shares.filter((s) => s !== '—').reduce((sum, s) => sum + Number(s.replace(',', '.').replace('%', '')), 0);
    expect(Math.abs(total - 100)).toBeLessThan(0.6);

    await row.getByRole('button').click();
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(slices(donut)).toHaveCount(all);
    await expect(centre).toHaveText(before!);
    expect(name.length).toBeGreaterThan(0);
  });

  test('the consistency donut leaves a badge out and recounts the holdings', async ({ page }) => {
    await page.goto('/dividends');
    const region = card(page, 'Dividend safety');
    const donut = region.getByTestId('consistency-donut');
    const legend = region.getByTestId('consistency-legend');
    await expect(slices(donut).first()).toBeVisible();
    const all = await settledCount(slices(donut));
    const centre = region.getByTestId('consistency-donut-centre');
    const before = Number((await centre.textContent())!.replace(/\D/g, ''));
    await legend.getByRole('button', { name: /^Reliable/ }).click();
    await expect(slices(donut)).toHaveCount(all - 1);
    expect(Number((await centre.textContent())!.replace(/\D/g, ''))).toBeLessThan(before);
    await expect(legend.getByRole('button', { name: /^Reliable/ })).toHaveAttribute('aria-pressed', 'false');
    await legend.getByRole('button', { name: 'Show all' }).click();
    await expect(slices(donut)).toHaveCount(all);
  });
});

test.describe('Bar charts', () => {
  test('Future payments: a status or a month can be excluded and the average line follows', async ({ page }) => {
    await page.goto('/dividends');
    const region = card(page, 'Future payments');
    const chart = region.getByTestId('future-chart');
    const legend = region.getByTestId('future-legend');
    await expect(bars(chart).first()).toBeVisible();
    const all = await settledCount(bars(chart));
    const line = chart.locator('.recharts-reference-line line');
    await expect(line).toHaveCount(1);
    const y = await line.getAttribute('y1');

    await toggle(legend, 'Estimated (from history)').click();
    await expect.poll(() => bars(chart).count()).toBeLessThan(all);
    await expect(line).toHaveCount(1);
    expect(await line.getAttribute('y1')).not.toBe(y);
    await expect(region.getByText('The dashed line is the monthly average of the current selection.')).toBeVisible();

    const table = await openTable(region, 'Expected dividends per month');
    await expect(toggle(table, 'Estimated (from history)')).toHaveAttribute('aria-pressed', 'false');
    await table.getByRole('rowheader').first().getByRole('button').click();
    await expect(chart).toHaveAttribute('aria-label', /the 11 selected months/);

    await region.getByRole('button', { name: 'Show all' }).first().click();
    await expect(bars(chart)).toHaveCount(all);
    await expect(toggle(legend, 'Estimated (from history)')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Dividends received: the future series and the average line are toggles; the headline stays', async ({ page }) => {
    await page.goto('/dividends');
    const region = card(page, 'Dividends received');
    const chart = region.getByTestId('received-time-chart');
    const legend = region.getByTestId('received-legend');
    await expect(bars(chart).first()).toBeVisible();
    const headline = await region.getByTestId('received-total').textContent();
    const all = await settledCount(bars(chart));
    await expect(chart.getByText('avg', { exact: true })).toHaveCount(1);

    await toggle(legend, 'Declared (announced)').click();
    await toggle(legend, 'Estimated (from history)').click();
    await expect.poll(() => bars(chart).count()).toBeLessThan(all);
    await expect(chart.getByText('Upcoming', { exact: true })).toBeVisible();
    await toggle(legend, 'avg').click();
    await expect(chart.getByText('avg', { exact: true })).toHaveCount(0);
    await expect(region.getByTestId('received-total')).toHaveText(headline!);
    await expect(region.getByTestId('selection-note')).toBeVisible();

    const table = await openTable(region, 'Dividends received and upcoming per period');
    await expect(toggle(table, 'Declared (announced)')).toHaveAttribute('aria-pressed', 'false');
    // the totals column is not a toggle
    await expect(toggle(table, 'Total')).toHaveCount(0);
    await toggle(table, 'Received').click();
    await expect(region.getByTestId('nothing-selected')).toBeVisible();
    await region.getByTestId('nothing-selected').getByRole('button').click();
    await expect(bars(chart)).toHaveCount(all);
  });

  test('Dividends received by holding and Average annual growth drop a holding', async ({ page }) => {
    await page.goto('/dividends');
    for (const [name, testId, tableName] of [
      ['Dividends received by holding', 'received-holding-chart', 'Dividends received per holding'],
      ['Average annual growth', 'growth-cagr-chart', 'Average annual dividend growth per share'],
    ] as const) {
      const region = card(page, name);
      const chart = region.getByTestId(testId);
      await expect(bars(chart).first()).toBeVisible();
      const all = await settledCount(bars(chart));
      const table = await openTable(region, tableName);
      await table.getByRole('rowheader').first().getByRole('button').click();
      await expect(table.getByRole('rowheader').first().getByRole('button')).toHaveAttribute('aria-pressed', 'false');
      await expect(bars(chart)).toHaveCount(all - 1);
      await region.getByRole('button', { name: 'Show all' }).first().click();
      await expect(bars(chart)).toHaveCount(all);
    }
  });

  test('Dividend growth: a year, the forecast kinds and the lines can be excluded', async ({ page }) => {
    await page.goto('/dividends');
    const region = card(page, 'Dividend growth');
    const chart = region.getByTestId('year-compare-chart');
    const legend = region.getByTestId('growth-legend');
    // the forecast bars arrive with the overview: wait for it before counting
    await expect(region.getByTestId('forecast-summary')).toBeVisible();
    await expect(bars(chart).first()).toBeVisible();
    const all = await settledCount(bars(chart));
    await expect(chart.locator('path.recharts-line-curve')).toHaveCount(1);

    await toggle(legend, '2026').click();
    await expect(toggle(legend, '2026')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => bars(chart).count()).toBeLessThan(all);
    await expect(chart).toHaveAttribute('aria-label', /compared for 2024, 2025\./);
    await toggle(legend, 'Average of years').click();
    await expect(chart.locator('path.recharts-line-curve')).toHaveCount(0);

    const table = await openTable(region, 'Dividends received per calendar month and year');
    await expect(toggle(table, '2026')).toHaveAttribute('aria-pressed', 'false');
    await toggle(table, '2026').click();
    await expect(toggle(legend, '2026')).toHaveAttribute('aria-pressed', 'true');

    // timeline: the trend and the average are legend items too
    await region.getByText('Timeline', { exact: true }).click();
    const timeline = region.getByTestId('growth-timeline-chart');
    await expect(timeline.locator('path.recharts-line-curve').first()).toBeVisible();
    const lines = await timeline.locator('path.recharts-line-curve').count();
    await toggle(legend, 'Trend').click();
    await toggle(legend, '12-month average').click();
    await expect(timeline.locator('path.recharts-line-curve')).toHaveCount(lines - 2);
    await expect(region.getByTestId('selection-note')).toBeVisible();
    await region.getByRole('button', { name: 'Show all' }).first().click();
    await expect(timeline.locator('path.recharts-line-curve')).toHaveCount(lines);
  });
});

test.describe('Keyboard and screen readers', () => {
  test('a legend entry is a pressed-state button operated with Enter and Space', async ({ page }) => {
    await page.goto('/dividends');
    const legend = card(page, 'Future payments').getByTestId('future-legend');
    const declared = toggle(legend, 'Declared (announced)');
    await expect(declared).toHaveAttribute('aria-pressed', 'true');
    await declared.focus();
    await page.keyboard.press('Enter');
    await expect(declared).toHaveAttribute('aria-pressed', 'false');
    await expect(declared.getByText('Declared (announced)')).toHaveCSS('text-decoration-line', 'line-through');
    await page.keyboard.press('Space');
    await expect(declared).toHaveAttribute('aria-pressed', 'true');
    // a comfortable target, and the average line is plain text, not a control
    const box = await declared.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    await expect(legend.getByRole('button')).toHaveCount(2);
  });

  test('the data table explains how to include and exclude and keeps table semantics', async ({ page }) => {
    await page.goto('/dividends');
    const region = card(page, 'Average annual growth');
    const table = await openTable(region, 'Average annual dividend growth per share');
    await expect(table).toHaveAccessibleDescription('Click a column or row header to include or exclude it from the chart');
    await expect(table.getByRole('columnheader').first()).toHaveText('Holding');
    await expect(table.getByRole('rowheader').first()).toBeVisible();
    await expect(table.locator('[role=grid], [role=gridcell]')).toHaveCount(0);
    const rows = table.getByRole('rowheader').first().getByRole('button');
    await rows.focus();
    await page.keyboard.press('Enter');
    await expect(rows).toHaveAttribute('aria-pressed', 'false');
    await expect(rows).toHaveCSS('text-decoration-line', 'line-through');
    await expect(table.getByRole('button', { name: 'Show all' })).toHaveCount(0);
    await expect(region.getByRole('button', { name: 'Show all' }).first()).toBeVisible();
  });
});

test.describe('Layout with excluded entries', () => {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
    [320, 700],
  ] as const) {
    test(`the page never scrolls sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/dividends');
      await expect(page.getByTestId('year-compare-chart')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      // exclude something in every card, then open every data table
      for (const [name, entry] of [
        ['Yield / payout', 'Yield on cost'],
        ['Future payments', 'Declared (announced)'],
        ['Dividends received', 'Estimated (from history)'],
        ['Dividend growth', 'Average of years'],
      ] as const) {
        await toggle(card(page, name).locator('[data-testid$="legend"]').first(), entry).click();
      }
      for (const name of ['Passive income diversification', 'Dividend safety']) {
        await card(page, name).locator('[data-testid$="legend"]').first().getByRole('button').first().click();
      }
      for (const summary of await page.getByText('Show data table').all()) await summary.click();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      for (const region of await page.getByRole('region').all()) {
        const box = await region.boundingBox();
        if (box) expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      }
    });
  }
});
