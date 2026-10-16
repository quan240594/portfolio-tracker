import { expect, test, type Locator, type Page } from '@playwright/test';

const VWRL = 'Vanguard FTSE All-World UCITS ETF (Dist)';
const IWDA = 'iShares Core MSCI World UCITS ETF (Acc)';
const EMIM = 'iShares Core MSCI Emerging Markets IMI UCITS ETF (Acc)';
const WIDTHS = [1440, 390, 320];

/** Visible name elements neither overflow their box nor end in an ellipsis (checked on the element and its nearest ancestors). */
async function expectNotClipped(candidates: Locator): Promise<void> {
  const names = candidates.filter({ visible: true });
  await expect(names.first()).toBeVisible();
  const clipped = await names.evaluateAll((els) => {
    const ellipsis = (el: Element) => getComputedStyle(el).textOverflow === 'ellipsis';
    return els
      .filter((el) => {
        const chain = [el, el.parentElement, el.parentElement?.parentElement].filter((e): e is HTMLElement => e instanceof HTMLElement);
        return chain.some(ellipsis) || el.scrollWidth > el.clientWidth + 1;
      })
      .map((el) => el.textContent);
  });
  expect(clipped).toEqual([]);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.inner);
}

for (const width of WIDTHS) {
  test.describe(`Full security names at ${width}px (mock mode)`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('benchmark picker: symbol and full name on every option, inside the viewport', async ({ page }) => {
      await page.goto('/analytics');
      const bar = page.getByRole('region', { name: 'Benchmarks' });
      await bar.getByRole('button', { name: 'Select' }).click();
      const list = bar.getByRole('group', { name: 'Benchmarks' });
      await expect(list).toBeVisible();

      for (const name of [VWRL, IWDA, 'Vanguard FTSE All-World (Acc)', 'iShares Core S&P 500', 'iShares STOXX Europe 600']) {
        const option = list.getByText(name, { exact: false }).first();
        await expect(option).toContainText(name);
        await expectNotClipped(option);
      }
      for (const symbol of ['VWRL.AS', 'IWDA.AS', 'EXSA.DE', 'SXR8.DE', 'VWCE.DE']) await expectNotClipped(list.getByText(symbol, { exact: true }));
      await expect(list.getByText('no price data yet').first()).toBeVisible();

      const panel = await list.locator('xpath=..').boundingBox();
      expect(panel).not.toBeNull();
      expect(panel!.x).toBeGreaterThanOrEqual(0);
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(width);
      await expectNoPageOverflow(page);
    });

    test('Holdings: the full names of the holdings', async ({ page }) => {
      await page.goto('/holdings');
      for (const name of [VWRL, IWDA]) await expectNotClipped(page.getByText(name, { exact: true }));
      await expectNoPageOverflow(page);
    });

    test('Watchlist: the full name of a long-named ETF', async ({ page }) => {
      await page.goto('/watchlist');
      const name = page.getByRole('table', { name: 'Watchlist' }).getByText(EMIM, { exact: true });
      await expect(name).toBeVisible();
      await expectNotClipped(name);
      await expectNoPageOverflow(page);
    });

    test('Assets: the full names in the securities list', async ({ page }) => {
      await page.goto('/assets?portfolio=all');
      for (const name of [VWRL, IWDA]) await expectNotClipped(page.getByText(name, { exact: true }));
      await expectNoPageOverflow(page);
    });

    test('Dividends: the per-holding tables and ranked list keep names whole', async ({ page }) => {
      await page.goto('/dividends');
      await expect(page.getByRole('heading', { level: 1, name: 'Dividends' })).toBeVisible();
      const names = page.locator('th[scope="row"], [aria-label="Holdings ranked by expected annual income"] li span.font-medium');
      await expectNotClipped(names);
      await expectNoPageOverflow(page);
    });

    test('Calendar: the list shows the whole event text', async ({ page }) => {
      await page.goto('/calendar');
      await page.getByRole('radio', { name: 'List' }).locator('xpath=ancestor::label').click();
      const rows = page.getByRole('region', { name: 'Events' }).getByRole('listitem').locator('span.block');
      await expectNotClipped(rows);
      await expectNoPageOverflow(page);
    });

    test('Dashboard: top movers and top holdings keep names whole', async ({ page }) => {
      await page.goto('/');
      await expectNotClipped(page.getByRole('region', { name: /^Top day (gainers|losers)$/ }).locator('li div.text-xs'));
      await expectNoPageOverflow(page);
      const top = page.getByRole('region', { name: 'Top holdings' });
      await expect(top.getByText(IWDA, { exact: true })).toBeVisible();
      await expectNotClipped(top.locator('li div.text-xs'));
      await expectNoPageOverflow(page);
    });
  });
}
