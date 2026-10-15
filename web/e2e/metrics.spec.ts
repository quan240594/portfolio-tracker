import { expect, test } from '@playwright/test';

test.describe('Analytics → Metrics (mock mode)', () => {
  test('shows the five cards, explains the method and follows benchmark and portfolio scope', async ({ page }) => {
    await page.goto('/analytics');
    const tabs = page.getByRole('tablist', { name: 'Analytics' });
    await expect(tabs.getByRole('tab', { name: 'Metrics' })).toHaveAttribute('aria-selected', 'true');

    for (const title of [
      'Portfolio TWR',
      'Portfolio P/E',
      'Volatility / beta',
      'Risk-adjusted return / Sharpe ratio',
      'Risk-adjusted return / Sortino ratio',
    ]) {
      await expect(page.getByRole('heading', { level: 3, name: title })).toBeVisible();
    }
    await expect(page.getByTestId('twr-value')).toHaveText(/^[+\u2212]\d+,\d%$/);
    await expect(page.getByTestId('metric-twr')).toContainText('IWDA.AS:');
    await expect(page.getByTestId('pe-value')).toHaveText(/^\d+,\d×$/);
    await expect(page.getByTestId('pe-coverage')).toContainText(/Based on 4 of 5 stocks, \d+% of portfolio value\./);
    await expect(page.getByTestId('metric-volatility')).toContainText(/Volatility of your portfolio \(β = \d,\d{3}\)/);
    await expect(page.getByTestId('metric-sharpe')).toContainText(/Sharpe ratio = [\u2212]?\d,\d{3} — /);
    await expect(page.getByTestId('metric-sortino')).toContainText(/Sortino ratio = [\u2212]?\d,\d{3} — /);
    await expect(page.getByRole('meter')).toHaveCount(4);

    const info = page.getByTestId('metric-pe').locator('details', { hasText: 'How this is calculated' });
    await info.getByText('How this is calculated').click();
    await expect(info).toContainText('weighted harmonic mean');

    await page.getByRole('radio', { name: 'VWRL.AS' }).click();
    await expect(page.getByTestId('metric-twr')).toContainText('VWRL.AS:');
    await expect(page.getByTestId('metric-sharpe')).toContainText('Market = VWRL.AS');

    await page.getByRole('combobox', { name: 'Portfolio' }).selectOption({ label: 'Trading 212' });
    await expect(page.getByTestId('pe-coverage')).toContainText('Based on 3 of 4 stocks');
    await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
  });

  test('has no horizontal overflow on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/analytics?tab=metrics');
    await expect(page.getByTestId('metric-sortino')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
  });
});
