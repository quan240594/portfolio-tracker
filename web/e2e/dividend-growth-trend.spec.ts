import { expect, test, type Page } from '@playwright/test';

// The demo is relative to "today"; a fixed clock makes its figures reproducible.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
});

const card = (page: Page) => page.getByRole('region', { name: 'Dividend growth', exact: true });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const normalise = (text: string | null) => (text ?? '').replaceAll(/\s+/g, ' ').trim();

test.describe('Dividend growth: forecast and trend', () => {
  test('shows forecast bars and a summary that matches the Future payments card', async ({ page }) => {
    await page.goto('/dividends');
    const growth = card(page);
    await expect(growth.getByTestId('year-compare-chart')).toBeVisible();
    await expect(growth.getByRole('checkbox', { name: 'Show forecast' })).toBeChecked();
    await expect(growth.getByRole('radio', { name: 'By year' })).toBeChecked();

    const legend = growth.getByTestId('growth-legend');
    for (const text of ['2027 (forecast)', 'Declared (forecast)', 'Estimated (forecast)', 'Average of years']) await expect(legend).toContainText(text);
    // forecast bars use the calendar's status colours: pastel blue (declared) and pastel yellow (estimated)
    const chart = growth.getByTestId('year-compare-chart');
    await expect(chart.locator('path.recharts-rectangle[fill="#bfdbfe"]').first()).toBeVisible();
    await expect(chart.locator('path.recharts-rectangle[fill="#fde68a"]').first()).toBeVisible();

    const future = (await page.getByTestId('future-total').textContent())!;
    const summary = growth.getByTestId('forecast-summary');
    await expect(summary).toContainText(`Forecast next 12 months: ${normalise(future)} (declared`);
    await expect(summary).toHaveText(/Forecast next 12 months: €\s[\d.]+,\d{2} \(declared €\s[\d.]+,\d{2}, estimated €\s[\d.]+,\d{2}\) · Trend: [+−]€\s[\d.]+,\d{2}\/month per year/);
    await expect(chart).toHaveAttribute('aria-label', /Forecast bars \(declared and estimated\) are stacked on the received amounts for 2026 and 2027\./);
  });

  test('toggles the forecast and the view', async ({ page }) => {
    await page.goto('/dividends');
    const growth = card(page);
    const legend = growth.getByTestId('growth-legend');
    await expect(growth.getByTestId('year-compare-chart')).toBeVisible();
    // the checkbox is unchecked and disabled until the forecast has loaded: unchecking it earlier would be a no-op
    await expect(growth.getByRole('checkbox', { name: 'Show forecast' })).toBeEnabled();

    await growth.getByRole('checkbox', { name: 'Show forecast' }).uncheck();
    await expect(legend).not.toContainText('forecast');
    await expect(growth.getByTestId('year-compare-chart').locator('path.recharts-rectangle[fill="#bfdbfe"]')).toHaveCount(0);
    await growth.getByRole('checkbox', { name: 'Show forecast' }).check();
    await expect(legend).toContainText('2027 (forecast)');

    await growth.getByText('Timeline', { exact: true }).click();
    const timeline = growth.getByTestId('growth-timeline-chart');
    await expect(timeline).toBeVisible();
    await expect(growth.getByTestId('year-compare-chart')).toHaveCount(0);
    for (const text of ['Received', '12-month average', 'Trend', 'Trend (projected)']) await expect(legend).toContainText(text);
    await expect(timeline.locator('path.recharts-curve.recharts-line-curve')).toHaveCount(3); // average, trend, projection
    await expect(timeline.locator('path.recharts-curve[stroke-dasharray="6 4"]')).toHaveCount(1);
    await expect(timeline).toHaveAttribute('aria-label', /with forecast bars and a trend line\. Forecast next 12 months/);

    await growth.getByRole('checkbox', { name: 'Show forecast' }).uncheck();
    await expect(legend).not.toContainText('Trend (projected)');
    await expect(legend).toContainText('Trend');
    await expect(timeline.locator('path.recharts-rectangle[fill="#bfdbfe"]')).toHaveCount(0);
    await growth.getByText('By year', { exact: true }).click();
    await expect(growth.getByTestId('year-compare-chart')).toBeVisible();
  });

  test('the data tables carry the forecast as text, not only as colour', async ({ page }) => {
    await page.goto('/dividends');
    const growth = card(page);
    await growth.getByText('Show data table').click();
    const forecast = growth.getByRole('table', { name: 'Dividend forecast and trend per month' });
    await expect(forecast.getByRole('columnheader')).toHaveText(['Period', 'Received', 'Declared', 'Estimated', 'Trend']);
    const rows = forecast.getByRole('row');
    await expect(rows).toHaveCount(13);
    for (const row of (await rows.all()).slice(1)) await expect(row.getByRole('cell').first()).toContainText('Forecast');

    await growth.getByText('Timeline', { exact: true }).click();
    await growth.getByText('Show data table').click();
    const table = growth.getByRole('table', { name: 'Dividends received, forecast and trend per month' });
    await expect(table.getByRole('row')).toHaveCount(1 + 24 + 12);
    await expect(table.getByRole('rowheader', { name: /Forecast \(month in progress\)/ })).toHaveCount(1);
    await expect(table.getByRole('rowheader', { name: / · Forecast$/ })).toHaveCount(11);
  });

  test('documents the calculation and its limits', async ({ page }) => {
    await page.goto('/dividends');
    const method = card(page).getByTestId('trend-method');
    await method.getByText('How is this calculated?').click();
    await expect(method).toContainText('least squares');
    await expect(method).toContainText('never drops below € 0');
    await expect(method).toContainText('Not investment advice');
  });

  test('asks for 6 months of history instead of drawing a trend', async ({ page }) => {
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await original(input, init);
        if (!new Request(input).url.includes('/analytics/dividend-growth')) return response;
        const body = (await response.json()) as { byMonth: unknown[] };
        return Response.json({ ...body, byMonth: body.byMonth.slice(-4) });
      };
    });
    await page.goto('/dividends');
    const growth = card(page);
    await expect(growth.getByTestId('trend-note')).toHaveText('Needs at least 6 months of dividend history to show a trend.');
    await expect(growth.getByTestId('forecast-summary')).not.toContainText('Trend:');
    await expect(growth.getByTestId('forecast-summary')).toContainText('Forecast next 12 months');
    await growth.getByText('Timeline', { exact: true }).click();
    await expect(growth.getByTestId('trend-note')).toBeVisible();
    await expect(growth.getByTestId('growth-legend')).not.toContainText('Trend');
  });

  for (const [width, height] of [
    [1440, 900],
    [390, 844],
    [320, 700],
  ] as const) {
    test(`never scrolls the page sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/dividends');
      const growth = card(page);
      await expect(growth.getByTestId('year-compare-chart')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await growth.getByText('Show data table').click();
      await growth.getByTestId('trend-method').getByText('How is this calculated?').click();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await growth.getByText('Timeline', { exact: true }).click();
      await expect(growth.getByTestId('growth-timeline-chart')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      // the legend is outside the chart's own scroll area and stays inside the card
      const legend = await growth.getByTestId('growth-legend').boundingBox();
      const frame = await growth.boundingBox();
      expect(legend!.x + legend!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1);
    });
  }
});
