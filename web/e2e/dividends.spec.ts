import { expect, test } from '@playwright/test';

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
});
