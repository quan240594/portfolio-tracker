import { expect, test, type Page } from '@playwright/test';
import { gotoViaNav } from './nav';

// The note under the dashboard chart: a symbol the demo has no stored prices for (one the user adds) is valued at cost.
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function addUnpricedSymbol(page: Page) {
  await page.goto('/transactions');
  await page.getByRole('button', { name: 'Add transaction' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add transaction' });
  await dialog.getByLabel('Type').selectOption('BUY');
  await dialog.getByLabel('Symbol').fill('newco.as');
  await dialog.getByLabel('Quantity').fill('3');
  await dialog.getByLabel('Price per unit').fill('50');
  await dialog.getByLabel('Currency').fill('EUR');
  await dialog.getByRole('button', { name: 'Save transaction' }).click();
  await expect(dialog).toBeHidden();
}

for (const viewport of [
  { name: '1280 px', width: 1280, height: 900 },
  { name: '320 px', width: 320, height: 800 },
]) {
  test.describe(`Value chart note at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('appears under the title once a holding has no price history, and links to the coverage details', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('img', { name: /^Portfolio value from/ })).toBeVisible();
      await expect(page.getByTestId('valued-at-cost-note')).toHaveCount(0);

      // The demo keeps its data in the page: move on with the navigation, a reload would reset it.
      await addUnpricedSymbol(page);
      await gotoViaNav(page, 'Dashboard');
      const note = page.getByTestId('valued-at-cost-note');
      await expect(note).toBeVisible();
      await expect(note).toHaveText(/^1 of \d+ holdings has no price history before \d{2}-\d{2}-\d{4}; it is valued at cost until then \(details\)$/);
      await expect(page.getByRole('img', { name: /^Portfolio value from/ })).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await note.getByRole('link', { name: 'details' }).click();
      await expect(page).toHaveURL(/\/settings\/diagnostics#price-coverage$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Diagnostics' })).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
}
