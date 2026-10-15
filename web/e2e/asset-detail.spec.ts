import { expect, test, type Page } from '@playwright/test';

// Mock mode demo data: the main portfolio holds ASML.AS, BTC-EUR and the ETFs; "Trading 212" holds AAPL, MSFT, KO and JNJ.

/** Horizontal overflow of the page in pixels (0 = nothing sticks out). */
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('Assets → securities list and asset detail (mock mode)', () => {
  test('lists the securities of the portfolio scope and opens a security from its row', async ({ page }) => {
    await page.goto('/assets');
    await expect(page.getByRole('heading', { level: 1, name: 'Assets' })).toBeVisible();
    const securities = page.getByRole('region', { name: 'Securities in your portfolio' });
    const table = securities.getByRole('table');
    await expect(table.getByRole('rowheader')).toHaveCount(8);
    for (const symbol of ['AAPL', 'ASML.AS', 'BTC-EUR', 'VWRL.AS']) await expect(table.getByRole('link', { name: symbol, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Custom assets' })).toBeVisible();

    // Follows the portfolio scope.
    await page.getByLabel('Portfolio', { exact: true }).selectOption({ label: 'Trading 212' });
    await expect(table.getByRole('rowheader')).toHaveCount(4);
    await expect(table.getByRole('link', { name: 'ASML.AS', exact: true })).toHaveCount(0);

    // Search narrows the list; a row links to the detail page and keeps the scope.
    await securities.getByRole('searchbox', { name: 'Search securities' }).fill('micro');
    await expect(table.getByRole('rowheader')).toHaveCount(1);
    await table.getByRole('link', { name: 'MSFT', exact: true }).click();
    await expect(page).toHaveURL(/\/assets\/MSFT\?portfolio=trading-212$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Microsoft Corporation' })).toBeVisible();
    await expect(page).toHaveTitle('MSFT · Asset detail · Portfolio Tracker');
    // The nav keeps one Assets item, still highlighted.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assets' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: 'My positions' }).getByRole('listitem', { name: 'Trading 212 position' })).toBeVisible();
  });

  test('sorts the list, includes sold positions and links symbols like BTC-EUR and ASML.AS', async ({ page }) => {
    await page.goto('/assets');
    const table = page.getByRole('region', { name: 'Securities in your portfolio' }).getByRole('table');
    await table.getByRole('button', { name: /^Security/ }).click();
    await expect(table.getByRole('columnheader', { name: /Security/ })).toHaveAttribute('aria-sort', 'ascending');
    await expect(table.getByRole('rowheader').first()).toContainText('AAPL');
    await table.getByRole('link', { name: 'BTC-EUR', exact: true }).click();
    await expect(page).toHaveURL(/\/assets\/BTC-EUR$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Bitcoin' })).toBeVisible();
    await page.goBack();
    await table.getByRole('link', { name: 'ASML.AS', exact: true }).click();
    await expect(page).toHaveURL(/\/assets\/ASML\.AS$/);
    await expect(page.getByRole('heading', { level: 1, name: 'ASML Holding N.V.' })).toBeVisible();
  });

  test('shows the header, tabs, price chart with range buttons, benchmarks and the dividends tab', async ({ page }) => {
    await page.goto('/assets/AAPL?portfolio=all');
    await expect(page.getByRole('heading', { level: 1, name: 'Apple Inc.' })).toBeVisible();
    await expect(page.getByTestId('asset-price')).toHaveText(/US\$\s228,52/);
    await expect(page.getByLabel('Key statistics')).toContainText('Next earnings');

    const tabs = page.getByRole('tablist', { name: 'Security sections' });
    await expect(tabs.getByRole('tab')).toHaveText(['Overview', 'Dividends']);
    await expect(tabs.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');

    // Price history: the chart really draws, ranges and the chart type switch.
    const chart = page.getByTestId('asset-price-chart');
    await expect(chart).toBeVisible();
    await expect(chart.locator('svg path').first()).toBeAttached();
    const ranges = page.getByRole('group', { name: 'Price history range' });
    for (const label of ['7D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'All']) await expect(ranges.getByRole('button', { name: label, exact: true })).toBeVisible();
    const threeMonths = page.waitForRequest((r) => r.url().includes('/assets/AAPL/history') && r.url().includes('range=3M'));
    await ranges.getByRole('button', { name: '3M', exact: true }).click();
    await threeMonths;
    await expect(ranges.getByRole('button', { name: '3M', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('radio', { name: 'Price' }).click();
    await expect(chart).toHaveAccessibleName(/^Closing price of AAPL/);
    await page.getByRole('radio', { name: 'Performance %' }).click();
    await expect(chart).toHaveAccessibleName(/^Price change of AAPL/);

    // Data-table alternative.
    await page.getByRole('button', { name: 'Data table' }).first().click();
    await expect(page.getByRole('table', { name: 'AAPL price change over time' })).toBeVisible();
    await page.getByRole('button', { name: 'Data table' }).first().click();

    // Benchmark change is sent to the API and shown in the legend.
    const bar = page.getByRole('region', { name: 'Benchmarks' });
    const withVwrl = page.waitForRequest((r) => r.url().includes('/assets/AAPL/history') && decodeURIComponent(r.url()).includes('benchmarks=IWDA.AS,VWRL.AS'));
    await bar.getByRole('button', { name: 'Select' }).click();
    await bar.locator('label', { hasText: /VWRL\.AS/ }).click();
    await page.keyboard.press('Escape');
    await withVwrl;
    await expect(page.getByRole('region', { name: 'Price history' }).getByText('VWRL.AS').first()).toBeVisible();

    // Key figures, positions and the company profile.
    await expect(page.getByRole('complementary', { name: 'Key figures' })).toContainText('P/E ratio');
    await expect(page.getByRole('region', { name: 'My positions' }).getByRole('listitem', { name: 'Trading 212 position' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'About Apple Inc.' })).toContainText('US0378331005');

    // Dividends tab: with the keyboard, the URL keeps the tab.
    await tabs.getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Dividends' })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/tab=dividends/);
    await expect(page.getByTestId('asset-dividend-chart')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Dividend events of AAPL, newest first' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Dividends you received, newest first' })).toBeVisible();
  });

  test('follows a change of portfolio scope on the detail page', async ({ page }) => {
    await page.goto('/assets/AAPL?portfolio=default');
    const positions = page.getByRole('region', { name: 'My positions' });
    await expect(positions).toContainText('You have no position in AAPL in Main portfolio');
    await page.getByLabel('Portfolio', { exact: true }).selectOption({ label: 'Trading 212' });
    await expect(positions.getByRole('listitem', { name: 'Trading 212 position' })).toBeVisible();
    await expect(page).toHaveURL(/portfolio=trading-212/);
    await page.getByLabel('Portfolio', { exact: true }).selectOption({ label: 'All portfolios' });
    await expect(positions.getByRole('listitem', { name: 'Trading 212 position' })).toBeVisible();
  });

  test('shows a friendly page for an unknown symbol, with a way back', async ({ page }) => {
    await page.goto('/assets/NOPE?portfolio=trading-212');
    await expect(page.getByRole('heading', { name: 'We have no data for NOPE' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to assets' }).click();
    await expect(page).toHaveURL(/\/assets\?portfolio=trading-212$/);
    await expect(page.getByRole('region', { name: 'Securities in your portfolio' })).toBeVisible();
  });

  test('links the symbols of the holdings table to their detail page', async ({ page }) => {
    await page.goto('/holdings?portfolio=all');
    await page.getByRole('table').getByRole('link', { name: 'KO', exact: true }).click();
    await expect(page).toHaveURL(/\/assets\/KO\?portfolio=all$/);
    await expect(page.getByRole('heading', { level: 1, name: 'The Coca-Cola Company' })).toBeVisible();
  });

  for (const width of [1440, 390]) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`nothing sticks out of the viewport at ${width}px (${scheme})`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
        const page = await context.newPage();
        await page.addInitScript((t) => localStorage.setItem('pt-theme', t), scheme);
        for (const path of ['/assets', '/assets/ASML.AS', '/assets/AAPL?tab=dividends', '/assets/BTC-EUR', '/assets/NOPE']) {
          await page.goto(path);
          await expect(page.getByRole('main')).toBeVisible();
          await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
          expect(await overflow(page), `${path} overflows at ${width}px`).toBe(0);
        }
        // Every table and card inside the page stays within the viewport too.
        await page.goto('/assets');
        await page.getByRole('checkbox', { name: 'Include sold positions' }).check();
        const widest = await page.evaluate(() => Math.max(...[...document.querySelectorAll('main section, main table')].map((el) => el.getBoundingClientRect().right)));
        expect(widest).toBeLessThanOrEqual(width);
        await context.close();
      });
    }
  }
});
