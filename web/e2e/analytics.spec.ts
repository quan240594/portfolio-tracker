import { expect, test } from '@playwright/test';

test.describe('Analytics (mock mode)', () => {
  test('dashboard shows IRR, passive income, insights and movers; the analytics page walks through every tab', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Passive income (next 12 months)' }).getByTestId('kpi-value')).toHaveText(/€\s[\d.]+,\d{2}$/);
    await expect(page.getByRole('region', { name: 'Money-weighted return (IRR)' }).getByTestId('kpi-value')).toHaveText(/[+\u2212]?[\d.]+,\d{2}\s?%/);
    await expect(page.getByRole('region', { name: 'Top day gainers' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Top day losers' })).toBeVisible();

    const insights = page.getByRole('region', { name: 'Portfolio insights' });
    await expect(insights).toBeVisible();
    const cards = insights.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^Dismiss insight/ }) });
    const before = await cards.count();
    expect(before).toBeGreaterThan(0);
    await cards.first().getByRole('button', { name: /^Dismiss insight/ }).click();
    await expect(page.getByRole('button', { name: /^Show \d+ dismissed$/ })).toBeVisible();

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Analytics' }).click();
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
    await expect(page.getByRole('table', { name: /Returns per year/ })).toBeVisible();
    await page.getByRole('radio', { name: 'Month' }).click();
    await expect(page.getByRole('table', { name: /Returns per month/ })).toBeVisible();

    const tabs = page.getByRole('tablist', { name: 'Analytics' });
    await tabs.getByRole('tab', { name: 'Risk' }).click();
    await expect(page.getByRole('table', { name: 'Risk metrics' })).toBeVisible();
    await tabs.getByRole('tab', { name: 'Benchmark' }).click();
    await expect(page.getByText('Your return (TWR)')).toBeVisible();
    await expect(page.getByTestId('benchmark-chart')).toBeVisible();
    await tabs.getByRole('tab', { name: 'Dividend growth' }).click();
    await expect(page.getByRole('table', { name: 'Dividends per year' })).toBeVisible();
    await tabs.getByRole('tab', { name: 'Income goal' }).click();
    await expect(page.getByRole('table', { name: 'Projection per scenario' })).toBeVisible();
    await page.getByLabel('Target annual income (€)').fill('6000');
    await page.getByRole('button', { name: 'Update projection' }).click();
    await expect(page.getByText(/^Starting from/)).toContainText('€ 6.000,00');
  });
});
