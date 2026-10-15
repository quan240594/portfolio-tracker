import { expect, test } from '@playwright/test';

test.describe('Analytics → Growth (mock mode)', () => {
  test('is the first tab and shows the benchmark headline, charts, dynamics and holdings performance', async ({ page }) => {
    await page.goto('/analytics');
    const tabs = page.getByRole('tablist', { name: 'Analytics' });
    await expect(tabs.getByRole('tab').first()).toHaveText('Growth');
    await expect(tabs.getByRole('tab', { name: 'Growth', exact: true })).toHaveAttribute('aria-selected', 'true');

    await expect(page.getByText(/^Your portfolio is (ahead of|behind) IWDA\.AS by €\s[\d.]+,\d{2}/)).toBeVisible();
    for (const id of ['growth-value-chart', 'growth-performance-chart', 'growth-dynamics-chart', 'growth-holdings-chart']) {
      await expect(page.getByTestId(id)).toBeVisible();
      // the charts really draw: they are not empty
      await expect(page.getByTestId(id).locator('svg path').first()).toBeAttached();
    }

    const value = page.getByRole('region', { name: 'Portfolio value' });
    await value.getByRole('button', { name: '3M' }).click();
    await expect(value.getByRole('button', { name: '3M' })).toHaveAttribute('aria-pressed', 'true');
    await expect(value.getByTestId('growth-value-chart')).toBeVisible();

    await value.getByRole('button', { name: 'Data table' }).click();
    await expect(value.getByRole('table', { name: 'Portfolio value over time' })).toBeVisible();

    const dynamics = page.getByRole('region', { name: 'Dynamics of portfolio returns' });
    await dynamics.getByRole('button', { name: 'View details' }).click();
    await expect(dynamics.getByRole('table', { name: 'Monthly returns, newest first' })).toBeVisible();

    const holdings = page.getByRole('region', { name: 'Holdings performance' });
    await holdings.getByRole('radio', { name: 'Table' }).click();
    await expect(holdings.getByRole('table', { name: 'Return per holding, best first' })).toBeVisible();
    await holdings.getByRole('radio', { name: 'Bars' }).click();
    await expect(holdings.getByTestId('growth-holdings-chart')).toBeVisible();
  });

  test('adds a benchmark through the popover and keeps it in the URL across a reload', async ({ page }) => {
    await page.goto('/analytics');
    const bar = page.getByRole('region', { name: 'Benchmarks' });
    await bar.getByRole('button', { name: 'Select' }).click();
    await bar.locator('label', { hasText: /VWRL\.AS/ }).click();
    await page.keyboard.press('Escape');
    await expect(bar.getByRole('group', { name: 'Benchmarks' })).toBeHidden();
    await expect(page).toHaveURL(/benchmarks=IWDA\.AS%2CVWRL\.AS/);
    await expect(bar.getByRole('list', { name: 'Selected benchmarks' }).getByRole('listitem')).toHaveCount(2);

    await page.reload();
    await expect(bar.getByRole('list', { name: 'Selected benchmarks' }).getByRole('listitem')).toHaveCount(2);
    await expect(page.getByRole('region', { name: 'Portfolio value' }).getByText('VWRL.AS')).toBeVisible();

    await bar.getByRole('button', { name: 'Remove VWRL.AS' }).click();
    await expect(bar.getByRole('list', { name: 'Selected benchmarks' }).getByRole('listitem')).toHaveCount(1);
  });

  for (const width of [1440, 390]) {
    test(`keeps the benchmark picker inside the viewport at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/analytics');
      const bar = page.getByRole('region', { name: 'Benchmarks' });
      await bar.getByRole('button', { name: 'Select' }).click();
      const options = bar.getByRole('group', { name: 'Benchmarks' });
      await expect(options).toBeVisible();
      const panel = await options.locator('xpath=..').boundingBox();
      expect(panel).not.toBeNull();
      expect(panel!.x).toBeGreaterThanOrEqual(0);
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(width);
    });
  }

  test('follows the portfolio scope', async ({ page }) => {
    await page.goto('/analytics?portfolio=trading-212');
    await expect(page.getByTestId('growth-value-chart')).toBeVisible();
    await expect(page.getByTestId('growth-holdings-chart')).toBeVisible();
  });
});
