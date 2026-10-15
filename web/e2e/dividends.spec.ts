import { expect, test, type Page } from '@playwright/test';

const CARDS = [
  'Yield / payout',
  'Passive income diversification',
  'Payment consistency',
  'Average annual growth',
  'Future payments',
  'Dividends received',
  'Dividends received by holding',
  'Dividend growth',
];

test.describe('Dividends page (mock mode)', () => {
  test('shows the dashboard with realistic data in every card', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/dividends');
    await expect(page.getByRole('heading', { level: 1, name: 'Dividends' })).toBeVisible();

    await expect(page.getByTestId('kpi-yield')).toHaveText(/^\d+,\d{2}%$/);
    await expect(page.getByTestId('kpi-income')).toHaveText(/^€\s[\d.]+,\d{2}$/);
    for (const name of CARDS) await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
    for (const id of ['yield-payout-chart', 'income-donut', 'consistency-donut', 'growth-cagr-chart', 'future-chart', 'received-time-chart', 'received-holding-chart', 'year-compare-chart']) {
      await expect(page.getByTestId(id)).toBeVisible();
      // an empty chart would render no bars/slices/series at all
      await expect(page.getByTestId(id).locator('path.recharts-rectangle, path.recharts-sector').first()).toBeVisible();
    }
    await expect(page.getByRole('alert')).toHaveCount(0);

    const consistency = page.getByRole('region', { name: 'Payment consistency' });
    for (const badge of ['Reliable', 'OK', 'Irregular', 'New']) await expect(consistency.getByRole('table').getByText(badge, { exact: true }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('selectors change the charts, tips and the history disclose and collapse', async ({ page }) => {
    await page.goto('/dividends');
    const payout = page.getByRole('region', { name: 'Yield / payout', exact: true });
    await expect(payout.getByTestId('yield-payout-chart')).toHaveAttribute('aria-label', /^Dividend yield per/);
    await payout.getByRole('radio', { name: 'Amount (EUR)' }).click();
    await expect(payout.getByTestId('yield-payout-chart')).toHaveAttribute('aria-label', /^Forward annual dividend amount per/);

    const received = page.getByRole('region', { name: 'Dividends received', exact: true });
    const total = received.getByTestId('received-total');
    await expect(total).toBeVisible();
    const allTime = await total.textContent();
    await received.getByRole('radio', { name: 'YTD' }).click();
    await expect(received.getByText('received this year to date')).toBeVisible();
    await received.getByRole('radio', { name: 'Yearly' }).click();
    await received.getByText('Show data table').click();
    await expect(received.getByRole('table', { name: 'Dividends received per period' }).getByRole('cell').first()).toHaveText(/^\d{4}$/);
    expect(allTime).toMatch(/€/);

    const growth = page.getByRole('region', { name: 'Payment consistency' });
    await growth.getByText('How is the score calculated?').click();
    await expect(growth.getByText(/Based on your payment history, not a forecast or advice. It says nothing/)).toBeVisible();

    await page.getByLabel('About Future payments').click();
    await expect(page.getByText(/Declared = announced dividends/)).toBeVisible();

    const history = page.getByRole('table', { name: 'Received dividends, newest first' });
    await expect(history).toBeVisible();
    await page.getByText('Payment history', { exact: true }).click();
    await expect(history).toBeHidden();
  });

  test('follows the portfolio switcher', async ({ page }) => {
    await page.goto('/dividends');
    const income = page.getByTestId('kpi-income');
    await expect(income).toBeVisible();
    const combined = await income.textContent();
    await page.getByLabel('Portfolio', { exact: true }).selectOption({ label: 'Trading 212' });
    await expect(page).toHaveURL(/\/dividends\?portfolio=trading-212$/);
    await expect(page.getByText(/^Trading 212 · amounts in EUR/)).toBeVisible();
    await expect(income).not.toHaveText(combined!);
    // categories exist for the main portfolio only
    await expect(page.getByRole('radiogroup', { name: 'Group by' })).toHaveCount(0);
    await page.getByLabel('Portfolio', { exact: true }).selectOption({ label: 'Main portfolio' });
    await expect(page.getByRole('radio', { name: 'Categories' })).toBeVisible();
  });

  test('works in dark mode on a phone-sized screen without horizontal overflow', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pt-theme', 'dark'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/dividends');
    await expect(page.getByTestId('year-compare-chart')).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    // an open info tip stays inside the viewport too
    await page.getByLabel('About Passive income diversification').click();
    await expect(page.getByText(/How your expected dividend income/)).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });

  test.describe('growth stats under the Dividend growth chart', () => {
    // The demo is relative to "today"; a fixed clock makes its figures reproducible (pinned in mocks/dividendDemo.test.ts).
    test.beforeEach(async ({ page }) => {
      await page.clock.setFixedTime(new Date('2026-10-15T10:00:00Z'));
    });

    const card = (page: Page) => page.getByRole('region', { name: 'Dividend growth', exact: true });
    const euros = (text: string | null) => Number((text ?? '').replaceAll(/[^\d,]/g, '').replace(',', '.'));
    const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    test('shows quarter over quarter, year over year and CAGR that reconcile with the chart data', async ({ page }) => {
      await page.goto('/dividends');
      const stats = card(page).getByTestId('growth-stats');
      await expect(stats).toBeVisible();
      await expect(stats.getByRole('heading', { level: 3 })).toHaveText(['Quarter over quarter', 'Year over year', 'All-time CAGR']);

      // value = arrow + sign + percentage (never colour only), then the absolute change in euros
      await expect(stats.getByTestId('growth-stat-qoq-value')).toHaveText('▲+65,5%');
      await expect(stats.getByTestId('growth-stat-qoq-change')).toHaveText(/^· \+€\s52,03$/);
      await expect(stats.getByTestId('growth-stat-qoq-periods')).toHaveText('Q3 2026 vs Q2 2026');
      await expect(stats.getByTestId('growth-stat-yoy-value')).toHaveText('▲+16,7%');
      await expect(stats.getByTestId('growth-stat-yoy-change')).toHaveText(/^· \+€\s59,06$/);
      await expect(stats.getByTestId('growth-stat-yoy-periods')).toHaveText(/^okt\.? 25 – sep\.? 26 vs okt\.? 24 – sep\.? 25$/);
      await expect(stats.getByTestId('growth-stat-cagr-value')).toHaveText('▲+92,0%');
      await expect(stats.getByTestId('growth-stat-cagr-periods')).toHaveText('2023 → 2025 · 2 years');

      // the explanation names the start and end amounts
      const cagr = stats.getByTestId('growth-stat-cagr');
      await cagr.getByText('How is this calculated?').click();
      await expect(cagr.getByText(/^2023 €\s95,81 → 2025 €\s353,31 over 2 years$/)).toBeVisible();

      // Q3 2026 and Q2 2026 are the sums of the 2026 column of the data table
      await card(page).getByText('Show data table').click();
      const table = card(page).getByRole('table', { name: 'Dividends received per calendar month and year' });
      const column = (await table.getByRole('columnheader').allTextContents()).indexOf('2026');
      const cells = await table.getByRole('row').evaluateAll((rows, col) => rows.slice(1).map((r) => r.children[col]?.textContent ?? ''), column);
      const quarter = (first: number) => Math.round(cells.slice(first, first + 3).reduce((sum, c) => sum + euros(c), 0) * 100) / 100;
      expect(quarter(6)).toBe(131.51);
      expect(quarter(3)).toBe(79.48);
    });

    test('shows dashes with a short explanation when there is not enough history', async ({ page }) => {
      await page.addInitScript(() => {
        const original = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const response = await original(input, init);
          const url = new Request(input).url;
          if (!url.includes('/analytics/dividend-growth')) return response;
          const body = (await response.json()) as Record<string, unknown>;
          return Response.json({ ...body, growthStats: { asOf: '2026-10-15', qoq: null, yoy: null, cagr: null } });
        };
      });
      await page.goto('/dividends');
      const stats = card(page).getByTestId('growth-stats');
      for (const id of ['qoq', 'yoy', 'cagr']) await expect(stats.getByTestId(`growth-stat-${id}-value`)).toHaveText('—');
      await expect(stats.getByTestId('growth-stat-yoy-periods')).toHaveText('Needs at least 2 years of dividend history.');
      await expect(stats.getByTestId('growth-stat-cagr-periods')).toHaveText('Needs at least 2 complete calendar years of dividends.');
      await expect(stats.getByTestId('growth-stat-qoq-change')).toHaveCount(0);
    });

    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      test(`fits the screen without horizontal overflow at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.goto('/dividends');
        const stats = card(page).getByTestId('growth-stats');
        await expect(stats).toBeVisible();
        const tiles = stats.locator(':scope > li');
        await expect(tiles).toHaveCount(3);
        for (const details of await tiles.locator('summary').all()) await details.click();
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
        const boxes = await Promise.all((await tiles.all()).map((t) => t.boundingBox()));
        for (const box of boxes) expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        // three in a row on a desktop, stacked on a phone
        const tops = new Set(boxes.map((b) => Math.round(b!.y)));
        expect(tops.size).toBe(width >= 768 ? 1 : 3);
      });
    }
  });
});
