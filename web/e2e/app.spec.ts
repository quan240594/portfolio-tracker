import { expect, test, type Page } from '@playwright/test';

const firstRowSymbol = (page: Page) =>
  page.getByRole('table').getByRole('rowheader').first().locator('span.font-semibold');

test.describe('Portfolio Tracker (mock mode)', () => {
  test('dashboard loads with KPIs, value chart and allocation', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Dashboard · Portfolio Tracker/);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

    for (const label of ['Total value', 'Day change', 'Unrealized P&L', 'Currency effect', 'Total return', 'Dividends received']) {
      const card = page.getByRole('region', { name: label, exact: true });
      // Dutch formatting: "€ 12.345,67" (thousands dot, decimal comma).
      await expect(card.getByTestId('kpi-value')).toHaveText(/€\s[+\u2212]?[\d.]+,\d{2}$/);
    }
    // The demo's euro strengthened against the dollar → negative currency effect.
    await expect(page.getByRole('region', { name: 'Currency effect', exact: true }).getByTestId('kpi-value')).toContainText('\u2212');

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

    // EUR-first unit prices with the USD price underneath, and a currency effect for USD holdings.
    const aapl = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: /AAPL/ }) });
    await expect(aapl.getByRole('cell').nth(2)).toHaveText(/^€\s[\d.]+,\d{2}\s*US\$\s[\d.]+,\d{2}$/);
    await expect(aapl.getByRole('cell').nth(6)).toContainText('\u2212');
    await table.getByRole('button', { name: 'Currency effect' }).click();
    await expect(table.getByRole('columnheader', { name: 'Currency effect' })).toHaveAttribute('aria-sort', 'descending');

    await table.getByRole('button', { name: /^Holding/ }).click();
    await expect(table.getByRole('columnheader', { name: /^Holding/ })).toHaveAttribute('aria-sort', 'ascending');
    await expect(firstRowSymbol(page)).toHaveText('AAPL');

    await table.getByRole('button', { name: /^Holding/ }).click();
    await expect(firstRowSymbol(page)).toHaveText('VWRL.AS');

    await table.getByRole('button', { name: /^Weight/ }).click();
    await expect(table.getByRole('columnheader', { name: /^Weight/ })).toHaveAttribute('aria-sort', 'descending');
    const weights = await table.locator('tbody tr td:last-child').allInnerTexts();
    const values = weights.map((w) => parseFloat(w.replace('%', '').replace(',', '.')));
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
    await expect(row).toContainText('€ 806,90');

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

  test('multiple portfolios: create one, add a transaction to it, switch scope and see it', async ({ page }) => {
    await page.goto('/transactions');
    await expect(page.getByRole('table')).toBeVisible();
    const switcher = page.getByRole('combobox', { name: 'Portfolio' });
    await expect(switcher).toHaveValue('all');
    await expect(switcher.getByRole('option')).toHaveText(['All portfolios', 'Main portfolio', 'Trading 212']);

    await page.getByRole('button', { name: 'Manage portfolios' }).click();
    const manage = page.getByRole('dialog', { name: 'Manage portfolios' });
    await expect(manage.getByLabel('New portfolio name')).toBeFocused();
    await manage.getByLabel('New portfolio name').fill('Main portfolio');
    await manage.getByRole('button', { name: 'Create portfolio' }).click();
    await expect(manage.getByRole('alert')).toContainText('already exists');
    await manage.getByLabel('New portfolio name').fill('Pension');
    await manage.getByRole('button', { name: 'Create portfolio' }).click();
    await expect(manage.getByText('Created “Pension”.')).toBeVisible();
    await expect(manage.getByRole('list', { name: 'Portfolios' })).toContainText('Pension');
    await page.keyboard.press('Escape');
    await expect(manage).toBeHidden();

    await page.getByRole('button', { name: 'Add transaction' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add transaction' });
    await expect(dialog.getByLabel('Portfolio')).toHaveValue('default');
    await dialog.getByLabel('Portfolio').selectOption({ label: 'Pension' });
    await dialog.getByLabel('Symbol').fill('IWDA.AS');
    await dialog.getByLabel('Quantity').fill('3');
    await dialog.getByLabel('Price per unit').fill('95,50');
    await dialog.getByRole('button', { name: 'Save transaction' }).click();
    await expect(dialog).toBeHidden();

    // Combined list shows which portfolio each row belongs to.
    const row = page.getByRole('row').filter({ hasText: '€ 286,50' });
    await expect(row).toContainText('Pension');

    await switcher.selectOption({ label: 'Pension' });
    await expect(page).toHaveURL(/[?&]portfolio=[a-z0-9-]+/);
    await expect(page.getByRole('columnheader', { name: 'Portfolio' })).toHaveCount(0);
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
    await expect(page.getByRole('table')).toContainText('IWDA.AS');

    // Nav links keep the scope; holdings only contain the new position.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Holdings' }).click();
    await expect(page).toHaveURL(/\/holdings\?portfolio=/);
    await expect(page.getByText(/^Pension · 1 positions/)).toBeVisible();
    await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(1);

    // The choice survives a reload without the URL param (localStorage fallback; mock data itself resets on reload).
    await switcher.selectOption({ label: 'Trading 212' });
    await expect(page).toHaveURL(/\/holdings\?portfolio=trading-212$/);
    await page.goto('/dividends');
    await expect(page).toHaveURL(/\/dividends\?portfolio=trading-212$/);
    await expect(switcher).toHaveValue('trading-212');
    await expect(page.getByText(/^Trading 212 · amounts in EUR/)).toBeVisible();
  });
});

