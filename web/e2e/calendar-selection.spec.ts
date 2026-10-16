import { expect, test, type Locator, type Page } from '@playwright/test';

/** Include / exclude of statuses and months in the Calendar income chart through the legend and the data table (mock mode). */

test.beforeEach(async ({ page }) => {
  // the demo is relative to "today": a fixed clock makes it reproducible
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
});

const card = (page: Page) => page.getByRole('region', { name: 'Income per month', exact: true });
const bars = (chart: Locator) => chart.locator('path.recharts-rectangle');
const valueLabels = (chart: Locator) => chart.locator('.recharts-label-list text');
const axisTicks = (chart: Locator) => chart.locator('.recharts-yAxis .recharts-cartesian-axis-tick-value');
const toggle = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const kpis = (page: Page) => page.getByRole('region', { name: /^(Annual income|Monthly average|Daily average|Yield)$/ }).getByTestId('kpi-value').allTextContents();

async function openTable(region: Locator): Promise<Locator> {
  await region.getByText('Show data table').click();
  const table = region.getByRole('table', { name: 'Dividend income per month' });
  await expect(table).toBeVisible();
  return table;
}

test.describe('Calendar income chart selection', () => {
  test('a legend entry hides a status and rescales; the table headers stay in sync; Show all resets; KPIs and the month grid do not change', async ({ page }) => {
    await page.goto('/calendar');
    const region = card(page);
    const chart = region.getByTestId('calendar-income-chart');
    const legend = region.getByTestId('calendar-income-legend');
    await expect(bars(chart).first()).toBeVisible();
    const all = await bars(chart).count();
    const labels = await valueLabels(chart).allTextContents();
    const ticks = await axisTicks(chart).allTextContents();
    const kpiValues = await kpis(page);
    const grid = await page.getByRole('region', { name: 'Events' }).innerText();
    const avgLine = chart.locator('.recharts-reference-line line');
    const avgY = await avgLine.getAttribute('y1');
    await expect(chart.getByText('avg', { exact: true })).toHaveCount(1);
    await expect(legend.getByText('avg', { exact: true })).toBeVisible();
    await expect(legend.getByRole('button', { name: 'avg' })).toHaveCount(0);

    const table = await openTable(region);
    await expect(toggle(legend, 'Received')).toHaveAttribute('aria-pressed', 'true');
    await toggle(legend, 'Received').click();
    await expect(toggle(legend, 'Received')).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle(table, 'Received')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => bars(chart).count()).toBeLessThan(all);
    await expect(region.getByTestId('selection-note')).toHaveText('Chart shows the current selection');
    await expect(chart).toHaveAttribute('aria-label', /current selection/);
    // totals above the bars and the avg line follow what is left
    await expect.poll(() => valueLabels(chart).allTextContents()).not.toEqual(labels);
    await expect.poll(() => avgLine.getAttribute('y1')).not.toBe(avgY);
    await expect(axisTicks(chart).first()).toBeVisible();

    // the table header toggles the same series, a row header a month
    await toggle(table, 'Received').click();
    await expect(toggle(legend, 'Received')).toHaveAttribute('aria-pressed', 'true');
    await expect(bars(chart)).toHaveCount(all);
    await toggle(table, 'Declared').click();
    await expect(toggle(legend, 'Declared')).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle(table, 'Total')).toHaveCount(0);
    await table.getByRole('rowheader').first().getByRole('button').click();
    await expect(chart).toHaveAttribute('aria-label', /current selection/);

    // headline numbers and the month grid describe the whole calendar
    expect(await kpis(page)).toEqual(kpiValues);
    expect(await page.getByRole('region', { name: 'Events' }).innerText()).toEqual(grid);

    await legend.getByRole('button', { name: 'Show all' }).click();
    await expect(bars(chart)).toHaveCount(all);
    await expect(valueLabels(chart)).toHaveText(labels);
    await expect(toggle(legend, 'Declared')).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle(table, 'Declared')).toHaveAttribute('aria-pressed', 'true');
    await expect(region.getByTestId('selection-note')).toHaveCount(0);
    expect(await axisTicks(chart).allTextContents()).toEqual(ticks);
  });

  test('the tooltip lists only the statuses that are included', async ({ page }) => {
    await page.goto('/calendar');
    const region = card(page);
    const chart = region.getByTestId('calendar-income-chart');
    const legend = region.getByTestId('calendar-income-legend');
    await expect(bars(chart).first()).toBeVisible();
    await bars(chart).first().hover();
    const tip = page.getByTestId('calendar-income-tooltip');
    await expect(tip).toContainText('Received');
    await expect(tip).toContainText('Declared');
    await expect(tip).toContainText('Estimated');
    await toggle(legend, 'Declared').click();
    await bars(chart).first().hover();
    await expect(tip).toContainText('Received');
    await expect(tip).not.toContainText('Declared');
    await expect(tip).toContainText('Total');
  });

  test('excluding every status shows the empty state, Show all brings the chart back', async ({ page }) => {
    await page.goto('/calendar');
    const region = card(page);
    const legend = region.getByTestId('calendar-income-legend');
    await expect(bars(region.getByTestId('calendar-income-chart')).first()).toBeVisible();
    for (const name of ['Received', 'Declared', 'Estimated']) await toggle(legend, name).click();
    await expect(region.getByTestId('nothing-selected')).toHaveText('Nothing selected: show all');
    await expect(region.getByTestId('calendar-income-chart')).toHaveCount(0);
    await region.getByTestId('nothing-selected').getByRole('button').click();
    await expect(bars(region.getByTestId('calendar-income-chart')).first()).toBeVisible();
  });

  for (const width of [1440, 390, 320]) {
    test(`the page does not scroll horizontally at ${width}px with the table open and a selection`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/calendar');
      const region = card(page);
      await expect(bars(region.getByTestId('calendar-income-chart')).first()).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const table = await openTable(region);
      await toggle(region.getByTestId('calendar-income-legend'), 'Estimated').click();
      await table.getByRole('rowheader').first().getByRole('button').click();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      // a hidden table never widens the page either
      await region.getByText('Show data table').click();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }
});
