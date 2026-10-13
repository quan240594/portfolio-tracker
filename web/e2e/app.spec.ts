import { expect, test, type Page } from '@playwright/test';

const firstRowSymbol = (page: Page) =>
  page.getByRole('table').getByRole('rowheader').first().locator('span.font-semibold');

test.describe('Portfolio Tracker (mock mode)', () => {
  test('dashboard loads with KPIs, value chart and allocation', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Dashboard · Portfolio Tracker/);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    for (const label of ['Total value', 'Day change', 'Unrealized P&L', 'Total return', 'Dividends received']) {
      const card = page.getByRole('region', { name: label, exact: true });
      await expect(card.getByTestId('kpi-value')).toHaveText(/€/);
    }

    const chart = page.getByTestId('value-chart');
    await expect(chart.locator('.recharts-area-area')).toBeVisible();

    const ranges = page.getByRole('radiogroup', { name: 'Chart range' });
    await ranges.getByRole('radio', { name: '3M' }).click();
    await expect(ranges.getByRole('radio', { name: '3M' })).toHaveAttribute('aria-checked', 'true');
    await expect(chart.locator('.recharts-area-area')).toBeVisible();

    const tabs = page.getByRole('tablist', { name: 'Allocation by' });
    await tabs.getByRole('tab', { name: 'Currency' }).click();
    await expect(page.getByRole('tabpanel')).toContainText('USD');
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Asset class' })).toHaveAttribute('aria-selected', 'true');

    await expect(page.getByRole('contentinfo')).toContainText('Not investment advice');
    await expect(page.getByRole('link', { name: 'CoinGecko' })).toHaveAttribute('href', 'https://www.coingecko.com');
  });

  test('navigate to holdings and sort the table', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Holdings' }).click();
    await expect(page).toHaveURL(/\/holdings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Holdings' })).toBeVisible();

    const table = page.getByRole('table');
    await expect(table.getByRole('rowheader')).toHaveCount(8);
    await expect(table.getByRole('columnheader', { name: /Market value/ })).toHaveAttribute('aria-sort', 'descending');
    await expect(table.getByText('Stale price')).toBeVisible();

    await table.getByRole('button', { name: /^Holding/ }).click();
    await expect(table.getByRole('columnheader', { name: /^Holding/ })).toHaveAttribute('aria-sort', 'ascending');
    await expect(firstRowSymbol(page)).toHaveText('AAPL');

    await table.getByRole('button', { name: /^Holding/ }).click();
    await expect(firstRowSymbol(page)).toHaveText('VWRL.AS');

    await table.getByRole('button', { name: /^Weight/ }).click();
    await expect(table.getByRole('columnheader', { name: /^Weight/ })).toHaveAttribute('aria-sort', 'descending');
    const weights = await table.locator('tbody tr td:last-child').allInnerTexts();
    const values = weights.map((w) => parseFloat(w.replace('%', '')));
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  test('add a transaction', async ({ page }) => {
    await page.goto('/transactions');
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();

    await page.getByRole('button', { name: 'Add transaction' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add transaction' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Date')).toBeFocused();

    // Validation errors from the shared schema
    await dialog.getByRole('button', { name: 'Save transaction' }).click();
    await expect(dialog.getByText('Symbol is required')).toBeVisible();
    await expect(dialog.getByLabel('Symbol')).toBeFocused();

    await dialog.getByLabel('Type').selectOption('BUY');
    await dialog.getByLabel('Symbol').fill('sap.de');
    await dialog.getByLabel('Quantity').fill('4');
    await dialog.getByLabel('Price per unit').fill('201.35');
    await dialog.getByLabel('Fee').fill('1.5');
    await dialog.getByLabel('Currency').fill('EUR');
    await dialog.getByLabel(/Note/).fill('E2E purchase');
    await dialog.getByRole('button', { name: 'Save transaction' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Added buy of 4 SAP.DE.' })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'SAP.DE' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('€806.90');

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Holdings' }).click();
    await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(9);
    await expect(page.getByRole('rowheader', { name: /SAP\.DE/ })).toBeVisible();
  });

  test('theme toggle persists across reloads', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Dark mode' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', 'true');
  });
});
