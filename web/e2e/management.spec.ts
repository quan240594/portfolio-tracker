import { expect, test } from '@playwright/test';

test.describe('Portfolio management (mock mode)', () => {
  test('rebalance: pick a portfolio, see the drift and get buy-only trades', async ({ page }) => {
    await page.goto('/rebalance');
    await expect(page.getByRole('heading', { name: 'Choose a portfolio' })).toBeVisible();
    await page.getByRole('button', { name: 'Main portfolio' }).click();
    await expect(page).toHaveURL(/portfolio=default/);

    const categories = page.getByRole('region', { name: 'Categories & targets' });
    await expect(categories.getByText('Core ETFs')).toBeVisible();
    await expect(categories.getByText(/Targets total 100%/)).toBeVisible();

    await page.getByLabel('Amount to invest (EUR)').fill('2500');
    await page.getByRole('button', { name: 'Calculate trades' }).click();

    const drift = page.getByRole('table', { name: 'Drift from target allocation per category' });
    await expect(drift.getByRole('rowheader', { name: 'Core ETFs' })).toBeVisible();
    const trades = page.getByRole('table', { name: 'Suggested trades' });
    await expect(trades.getByText('BUY').first()).toBeVisible();
    await expect(trades.getByText('SELL')).toHaveCount(0);
    await expect(page.getByText(/Leftover cash:/)).toBeVisible();

    // Full rebalance proposes sells as well.
    await page.getByRole('radio', { name: 'Full rebalance' }).click();
    await page.getByLabel(/New money to add/).fill('0');
    await page.getByRole('button', { name: 'Calculate trades' }).click();
    await expect(trades.getByText('SELL').first()).toBeVisible();
  });

  test('rebalance: a new category with a target shows up in the editor', async ({ page }) => {
    await page.goto('/rebalance?portfolio=trading-212');
    await expect(page.getByText(/No categories yet/)).toBeVisible();
    await page.getByRole('button', { name: 'Add category' }).click();
    const dialog = page.getByRole('dialog', { name: 'New category' });
    await dialog.getByLabel('Name').fill('US stocks');
    await dialog.getByLabel('Target weight (%)').fill('60');
    await dialog.getByRole('checkbox', { name: /AAPL/ }).check();
    await dialog.getByRole('button', { name: 'Save category' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('US stocks')).toBeVisible();
    await expect(page.getByText(/Targets total 60% · 40% left unallocated/)).toBeVisible();
  });

  test('watchlist: add a symbol from the page and remove it again; the dashboard shows the list', async ({ page }) => {
    await page.goto('/');
    const widget = page.getByRole('region', { name: 'Watchlist' });
    await expect(widget.getByText('NVDA')).toBeVisible();

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Watchlist' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Watchlist' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Watchlist' });
    await expect(table.getByRole('rowheader', { name: /NVDA/ })).toBeVisible();

    await page.getByLabel('Symbol').fill('amd');
    await page.getByRole('button', { name: 'Add to watchlist' }).click();
    await expect(table.getByRole('rowheader', { name: /AMD/ })).toBeVisible();
    await expect(table.getByText('Waiting for price…')).toBeVisible();

    await page.getByRole('button', { name: 'Remove AMD from watchlist' }).click();
    await expect(table.getByRole('rowheader', { name: /AMD/ })).toHaveCount(0);
  });

  test('cash, split and custom assets show up in holdings and transactions', async ({ page }) => {
    await page.goto('/holdings?portfolio=default');
    const table = page.getByRole('table');
    await expect(table.getByRole('rowheader', { name: /CASH\.EUR/ })).toBeVisible();
    await expect(table.getByRole('rowheader', { name: /Custom asset/ }).first()).toBeVisible();

    await page.goto('/transactions?portfolio=trading-212');
    await expect(page.getByRole('table').getByText('SPLIT', { exact: true })).toBeVisible();
  });
});
