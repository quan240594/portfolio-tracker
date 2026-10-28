import { expect, test, type Locator, type Page } from '@playwright/test';
import { settledCount } from './settled';

/** Include / exclude of series and rows through the legend and the data table: Dashboard, Analytics tabs and Goals (mock mode). */

test.beforeEach(async ({ page }) => {
  // the demo is relative to "today": a fixed clock makes it reproducible
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
});

const bars = (chart: Locator) => chart.locator('path.recharts-rectangle');
const slices = (chart: Locator) => chart.locator('path.recharts-sector');
const lines = (chart: Locator) => chart.locator('path.recharts-line-curve');
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const toggle = (scope: Locator, name: string | RegExp) => scope.getByRole('button', { name, exact: typeof name === 'string' });
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];

async function expectNoPageOverflow(page: Page) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    expect(await overflow(page), `${viewport.width}px`).toBeLessThanOrEqual(1);
  }
}

test.describe('Dashboard', () => {
  test('the value chart legend excludes a series, Show all resets, and the last one gives the empty state', async ({ page }) => {
    await page.goto('/');
    const card = page.getByRole('region', { name: 'Value vs invested', exact: true });
    const chart = card.getByTestId('value-chart');
    const legend = card.getByTestId('value-legend');
    await expect(chart.locator('.recharts-area-area')).toBeVisible();
    await expect(lines(chart)).toHaveCount(1);

    await toggle(legend, 'Invested').click();
    await expect(toggle(legend, 'Invested')).toHaveAttribute('aria-pressed', 'false');
    await expect(lines(chart)).toHaveCount(0);
    await expect(chart.locator('.recharts-area-area')).toBeVisible();
    await expect(card.getByTestId('selection-note')).toHaveText('Chart shows the current selection');
    // the headline above the chart describes the portfolio, not the selection
    await expect(card.getByText(/P&L change over period/)).toBeVisible();

    await toggle(legend, 'Value').click();
    await expect(card.getByTestId('nothing-selected')).toHaveText('Nothing selected: show all');
    await expect(chart).toHaveCount(0);
    await expect(toggle(legend, 'Value')).toHaveAttribute('aria-pressed', 'false');
    await card.getByTestId('nothing-selected').getByRole('button', { name: 'show all' }).click();
    await expect(chart.locator('.recharts-area-area')).toBeVisible();
    await expect(lines(chart)).toHaveCount(1);
    await expect(card.getByTestId('selection-note')).toHaveCount(0);
  });

  test('the allocation donut: legend and table rows toggle the same slice, the total in the middle follows', async ({ page }) => {
    await page.goto('/');
    const card = page.getByRole('region', { name: 'Allocation', exact: true });
    const donut = card.getByTestId('allocation-donut');
    const legend = card.getByTestId('allocation-legend');
    await expect(slices(donut).first()).toBeVisible();
    const all = await settledCount(slices(donut));
    expect(all).toBeGreaterThan(1);
    const centre = card.getByTestId('allocation-donut-centre');
    const before = await centre.textContent();
    const table = card.getByRole('table', { name: /^Allocation by/ });

    const first = legend.getByRole('button').first();
    const name = (await first.textContent())!;
    await first.click();
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle(table, name)).toHaveAttribute('aria-pressed', 'false');
    await expect(slices(donut)).toHaveCount(all - 1);
    await expect(centre).not.toHaveText(before!);
    await expect(centre).toContainText('selected');
    await expect(card.getByTestId('selection-note')).toHaveText('Chart shows the current selection');
    // the shares of the slices that are left add up to 100%
    const shares = await table.locator('tbody tr td:nth-of-type(2)').allTextContents();
    expect(shares.filter((s) => s === '—')).toHaveLength(1);
    const total = shares.filter((s) => s !== '—').reduce((sum, s) => sum + Number(s.replace(',', '.').replace('%', '')), 0);
    expect(Math.abs(total - 100)).toBeLessThan(0.6);

    await expectNoPageOverflow(page);
    await page.setViewportSize(VIEWPORTS[0]!);

    // the table's row header brings it back
    await toggle(table, name).click();
    await expect(slices(donut)).toHaveCount(all);
    await expect(first).toHaveAttribute('aria-pressed', 'true');

    // every slice excluded: empty state, legend stays; Show all resets
    const count = await legend.getByRole('button').count();
    for (let i = 0; i < count; i++) await legend.getByRole('button').nth(i).click();
    await expect(card.getByTestId('nothing-selected')).toBeVisible();
    await expect(donut).toHaveCount(0);
    await legend.getByRole('button', { name: 'Show all' }).click();
    await expect(slices(donut)).toHaveCount(all);

    // another dimension starts from the full set
    await first.click();
    await card.getByRole('tab', { name: 'Currency' }).click();
    await expect(card.getByTestId('selection-note')).toHaveCount(0);
  });
});

test.describe('Analytics tabs', () => {
  test('Returns: the legend and the period row headers exclude bars; the table keeps every period', async ({ page }) => {
    await page.goto('/analytics?tab=returns');
    const chart = page.getByTestId('returns-chart');
    const legend = page.getByTestId('returns-legend');
    const table = page.getByRole('table', { name: 'Returns per year, newest first' });
    await expect(bars(chart).first()).toBeVisible();
    const all = await settledCount(bars(chart));
    const rows = await table.getByRole('rowheader').count();
    expect(rows).toBeGreaterThan(1);

    await table.getByRole('rowheader').first().getByRole('button').click();
    await expect(bars(chart)).toHaveCount(all - 1);
    await expect(table.getByRole('rowheader')).toHaveCount(rows);
    await expect(table.getByRole('rowheader').first().getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('selection-note')).toHaveText('Chart shows the current selection');

    await toggle(legend, 'Return (TWR)').click();
    await expect(toggle(table, 'Return (TWR)')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('nothing-selected')).toBeVisible();
    await expect(chart).toHaveCount(0);
    await toggle(legend, 'Show all').click();
    await expect(bars(chart)).toHaveCount(all);
    await expect(page.getByTestId('selection-note')).toHaveCount(0);
    await expectNoPageOverflow(page);
  });

  test('Benchmark: the legend excludes lines and Show all brings them back', async ({ page }) => {
    await page.goto('/analytics?tab=benchmark');
    const chart = page.getByTestId('benchmark-chart');
    const legend = page.getByTestId('benchmark-legend');
    await expect(lines(chart).first()).toBeVisible();
    const all = await lines(chart).count();
    expect(all).toBe(3);

    await toggle(legend, 'Invested').click();
    await expect(toggle(legend, 'Invested')).toHaveAttribute('aria-pressed', 'false');
    await expect(lines(chart)).toHaveCount(all - 1);
    await toggle(legend, 'Portfolio').click();
    await expect(lines(chart)).toHaveCount(all - 2);
    // the comparison figures keep describing the whole period
    await expect(page.getByText('Your return (TWR)')).toBeVisible();
    await toggle(legend, 'Show all').click();
    await expect(lines(chart)).toHaveCount(all);
    await expectNoPageOverflow(page);
  });

  test('Dividend growth: a year row and a month series can be excluded in their own chart', async ({ page }) => {
    await page.goto('/analytics?tab=dividends');
    const yearChart = page.getByTestId('dividend-year-chart');
    const monthChart = page.getByTestId('dividend-month-chart');
    const yearTable = page.getByRole('table', { name: 'Dividends per year' });
    await expect(bars(yearChart).first()).toBeVisible();
    const years = await bars(yearChart).count();
    const months = await bars(monthChart).count();

    await yearTable.getByRole('rowheader').first().getByRole('button').click();
    await expect(bars(yearChart)).toHaveCount(years - 1);
    await expect(bars(monthChart)).toHaveCount(months);
    await expect(toggle(page.getByTestId('dividend-year-chart-legend'), 'Show all')).toBeVisible();

    await toggle(page.getByTestId('dividend-month-chart-legend'), 'A year earlier').click();
    await expect.poll(() => bars(monthChart).count()).toBeLessThan(months);
    await toggle(page.getByTestId('dividend-month-chart-legend'), 'Show all').click();
    await expect(bars(monthChart)).toHaveCount(months);
    await toggle(page.getByTestId('dividend-year-chart-legend'), 'Show all').click();
    await expect(bars(yearChart)).toHaveCount(years);
    await expectNoPageOverflow(page);
  });

  test('Income goal: the legend and the scenario rows toggle the same scenario', async ({ page }) => {
    await page.goto('/analytics?tab=goal');
    const chart = page.getByTestId('goal-chart');
    const legend = page.getByTestId('goal-legend');
    const table = page.getByRole('table', { name: 'Projection per scenario' });
    await expect(lines(chart).first()).toBeVisible();
    const all = await lines(chart).count();
    expect(all).toBe(3);

    await toggle(legend, 'Optimistic').click();
    await expect(toggle(table, 'Optimistic')).toHaveAttribute('aria-pressed', 'false');
    await expect(lines(chart)).toHaveCount(all - 1);
    await toggle(table, 'Cautious').click();
    await expect(toggle(legend, 'Cautious')).toHaveAttribute('aria-pressed', 'false');
    await expect(lines(chart)).toHaveCount(all - 2);
    await expect(table.getByRole('rowheader')).toHaveCount(3);
    await toggle(legend, 'Show all').click();
    await expect(lines(chart)).toHaveCount(all);
    await expectNoPageOverflow(page);
  });
});

test.describe('Goals', () => {
  test('excluding the goal line, a scenario column or a year leaves the verdict alone; the CSV keeps everything', async ({ page }) => {
    await page.goto('/goals');
    const verdict = page.locator('output').filter({ hasText: /Achievable in|Not reached within|already reached/ });
    await expect(verdict).toBeVisible();
    // The demo goal is unsaved, so on load the yield helper settles on its default and the preview replaces the first verdict once: read the verdict only after that.
    await expect(page.getByText('Preview of unsaved changes')).toBeVisible();
    const text = await verdict.textContent();
    const chart = page.getByTestId('goal-chart');
    const legend = page.getByTestId('goal-legend');
    const table = page.getByRole('table', { name: /per year for each scenario/ });
    await expect(lines(chart).first()).toBeVisible();
    const all = await lines(chart).count();
    expect(all).toBe(4);
    const rowCount = await table.getByRole('rowheader').count();

    await toggle(legend, 'Goal (inflation-adjusted)').click();
    await expect(lines(chart)).toHaveCount(all - 1);
    await expect(toggle(table, 'Goal')).toHaveAttribute('aria-pressed', 'false');
    await expect(verdict).toHaveText(text!);

    // a scenario column and a year row, both dimmed and struck through in the table, which keeps every year
    await toggle(table, 'Safe').click();
    await expect(lines(chart)).toHaveCount(all - 2);
    await toggle(table, 'Today').click();
    await expect(toggle(table, 'Today')).toHaveAttribute('aria-pressed', 'false');
    await expect(table.getByRole('rowheader')).toHaveCount(rowCount);
    await expect(table.locator('tbody tr').first().getByRole('cell').first()).toHaveClass(/line-through/);
    await expect(verdict).toHaveText(text!);
    await expect(page.getByTestId('selection-note')).toHaveText('Chart shows the current selection');
    await expect(page.getByText(/The CSV always contains every year and scenario/)).toBeVisible();

    // the export is complete: one line per year plus the header
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV' }).click();
    const stream = await (await download).createReadStream();
    let csv = '';
    for await (const chunk of stream) csv += String(chunk);
    expect(csv.trim().split('\n')).toHaveLength(rowCount + 1);

    await expectNoPageOverflow(page);
    await page.setViewportSize(VIEWPORTS[0]!);

    for (const name of ['Your plan', 'Alternative']) await toggle(legend, name).click();
    await expect(page.getByTestId('nothing-selected')).toBeVisible();
    await expect(chart).toHaveCount(0);
    await page.getByTestId('nothing-selected').getByRole('button', { name: 'show all' }).click();
    await expect(lines(chart)).toHaveCount(all);
    await expect(verdict).toHaveText(text!);
  });
});
