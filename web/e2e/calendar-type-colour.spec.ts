import { expect, test, type Locator, type Page } from '@playwright/test';

const events = (page: Page) => page.getByRole('region', { name: 'Events' });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

interface Paint {
  background: string;
  border: string;
  shadow: string;
}

const paintOf = (el: Locator): Promise<Paint> =>
  el.evaluate((node) => {
    const css = getComputedStyle(node);
    return { background: css.backgroundColor, border: css.borderLeftColor, shadow: css.boxShadow };
  });

/** A button of the given type and status: rows and chips carry data-type and data-status. */
const button = (scope: Locator, type: string, status: string) => scope.locator(`button[data-type="${type}"][data-status="${status}"]`).first();

/** The statuses that both an ex-dividend and a dividend payment have in the loaded range. */
async function sharedStatus(scope: Locator): Promise<string | undefined> {
  for (const status of ['CONFIRMED', 'PAID', 'ESTIMATED']) {
    if ((await button(scope, 'EX_DIVIDEND', status).count()) > 0 && (await button(scope, 'DIVIDEND_PAY', status).count()) > 0) return status;
  }
  return undefined;
}

for (const width of [320, 1280]) {
  test.describe(`Ex-dividend colour at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('in the list, an ex-dividend row differs in background from a payment row of the same status and both keep the status border', async ({ page }) => {
      await page.goto('/calendar?range=year');
      if (width >= 640) await page.getByRole('radio', { name: 'List' }).locator('xpath=ancestor::label').click();
      const list = events(page);
      await expect(list.getByRole('listitem').first()).toBeVisible();
      const status = await sharedStatus(list);
      expect(status, 'the demo has an ex-dividend and a payment of one status').toBeDefined();
      const exDividend = button(list, 'EX_DIVIDEND', status as string);
      const payment = button(list, 'DIVIDEND_PAY', status as string);
      await exDividend.scrollIntoViewIfNeeded();
      const [ex, pay] = [await paintOf(exDividend), await paintOf(payment)];
      expect(ex.background).not.toBe(pay.background);
      expect(ex.border, 'the status stays the left border').toBe(pay.border);
      // The status is still written on the row, and the type in its accessible name.
      await expect(exDividend.getByText(/^(Confirmed|Estimated|Received)$/)).toHaveCount(1);
      await expect(exDividend).toHaveAccessibleName(/, Ex-dividend, /);
      await expect(payment).toHaveAccessibleName(/, Dividend payment, /);
      // Two ex-dividends of different statuses stay violet: the type colour does not depend on the status.
      const others = await list.locator('button[data-type="EX_DIVIDEND"]').evaluateAll((nodes) => [...new Set(nodes.map((n) => getComputedStyle(n).backgroundColor))]);
      expect(others.length).toBe(1);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('the colour key is visible and does not overflow', async ({ page }) => {
      await page.goto('/calendar?range=year');
      const key = page.getByRole('list', { name: /Colours/ });
      await expect(key).toBeVisible();
      await expect(key.getByRole('listitem')).toHaveCount(4);
      await expect(key).toContainText('Ex-dividend: violet');
      const box = await key.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('in the month grid, an ex-dividend chip is violet and differs from the payment and earnings chips', async ({ page }) => {
      await page.goto('/calendar?view=calendar');
      const table = events(page).getByRole('table');
      await expect(table).toBeVisible();
      const chips = table.locator('button[data-type]');
      const seen = await chips.evaluateAll((nodes) => nodes.map((n) => `${n.getAttribute('data-type')}/${n.getAttribute('data-status')}`));
      const exDividends = new Set(seen.filter((s) => s.startsWith('EX_DIVIDEND/')));
      expect(exDividends.size).toBeGreaterThan(0);
      const first = table.locator('button[data-type="EX_DIVIDEND"]').first();
      await first.scrollIntoViewIfNeeded();
      const ex = await paintOf(first);
      expect(ex.background).toBe('rgb(233, 213, 255)');
      for (const other of ['DIVIDEND_PAY', 'EARNINGS']) {
        const chip = table.locator(`button[data-type="${other}"]`).first();
        if ((await chip.count()) > 0) expect((await paintOf(chip)).background).not.toBe(ex.background);
      }
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
}
