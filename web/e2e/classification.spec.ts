import { expect, test, type Page } from '@playwright/test';
import { gotoViaNav } from './nav';

// Mock mode demo data: AAPL is held (provider sector "Technology"), NVDA is only on the watchlist. The mock API keeps the owner's
// classification in memory like the real one keeps it per user, so the whole flow runs without a backend. A full page load resets it,
// hence the checks on other pages go through the navigation.

const HEADER = ['Holding', "Holdings' name", 'Shares', 'Currency', 'Country', 'Sector', 'Category', 'ISIN'];
const ROWS = [
  // Held, matched by ticker: a sector and a country the demo profile does not have.
  ['AAPL', 'Apple Inc.', '10', 'USD', 'Invented Land', 'Invented Sector', '', ''],
  // Not held: listed as unmatched with the reason.
  ['ZZZZ', 'Invented Corp', '5', 'USD', 'Germany', 'Utilities', 'Utilities', ''],
];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const CSV = [HEADER, ...ROWS].map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n';

/** Horizontal overflow of the page in pixels (0 = nothing sticks out). */
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function openSectorAllocation(page: Page) {
  await gotoViaNav(page, 'Dashboard');
  await page.getByRole('tablist', { name: 'Allocation by' }).getByRole('tab', { name: 'Sector' }).click();
  return page.getByRole('tabpanel');
}

test.describe('Asset classification (mock mode)', () => {
  test('imports a Snowball holdings file: preview, confirm, and the dashboard allocation follows', async ({ page }) => {
    await page.goto('/assets');
    const section = page.getByRole('region', { name: 'Asset classification' });
    await section.getByRole('button', { name: 'Import classification from Snowball' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import asset classification' });
    await expect(dialog.getByRole('button', { name: 'Confirm import' })).toBeDisabled();

    await dialog.getByLabel('Snowball Holdings CSV').setInputFiles({ name: 'holdings.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') });
    const preview = dialog.getByRole('table', { name: 'Import preview' });
    await expect(preview.getByRole('row', { name: /AAPL/ })).toContainText('matches AAPL by ticker');
    await expect(preview.getByRole('row', { name: /AAPL/ })).toContainText('Sector: Technology → Invented Sector');
    await expect(preview.getByRole('row', { name: /AAPL/ })).toContainText('Country: United States → Invented Land');
    await expect(preview.getByRole('row', { name: /ZZZZ/ })).toContainText('Not matched. Not one of your holdings');
    await expect(dialog.getByLabel('Summary')).toContainText('With changes1');

    await dialog.getByRole('button', { name: 'Confirm import' }).click();
    await expect(dialog.getByRole('status')).toContainText('Saved 1 classification.');
    await expect(dialog.getByRole('table', { name: 'Import result' }).getByRole('row', { name: /ZZZZ/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();

    // The securities table of the same page already follows, and so does the dashboard.
    const aapl = page.getByRole('region', { name: 'Securities in your portfolio' }).getByRole('row', { name: /AAPL/ });
    await expect(aapl).toContainText('Invented Sector');
    await expect(aapl).toContainText('Invented Land');
    await expect(await openSectorAllocation(page)).toContainText('Invented Sector');
  });

  test('cancelling the preview changes nothing', async ({ page }) => {
    await page.goto('/assets');
    await page.getByRole('button', { name: 'Import classification from Snowball' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import asset classification' });
    await dialog.getByLabel('Snowball Holdings CSV').setInputFiles({ name: 'holdings.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') });
    await expect(dialog.getByRole('table', { name: 'Import preview' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('region', { name: 'Securities in your portfolio' }).getByRole('row', { name: /AAPL/ })).not.toContainText('Invented Sector');
  });

  test('refuses a file that is not a holdings export', async ({ page }) => {
    await page.goto('/assets');
    await page.getByRole('button', { name: 'Import classification from Snowball' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import asset classification' });
    await dialog.getByLabel('Snowball Holdings CSV').setInputFiles({ name: 'transactions.csv', mimeType: 'text/csv', buffer: Buffer.from('date,type,symbol\n2024-01-01,BUY,AAPL\n') });
    await expect(dialog.getByRole('alert')).toContainText('Not a Snowball holdings export');
    await expect(dialog.getByRole('button', { name: 'Confirm import' })).toBeDisabled();
  });

  test('edits one security, shows that it was edited, and resets it', async ({ page }) => {
    await page.goto('/assets/AAPL?portfolio=all');
    const about = page.getByRole('region', { name: /^About / });
    await expect(about.getByText('Edited by you')).toHaveCount(0);
    const edit = about.getByRole('button', { name: 'Edit classification' });
    await edit.click();
    const dialog = page.getByRole('dialog', { name: 'Edit classification of AAPL' });
    await expect(dialog.getByLabel('Sector')).toHaveValue('Technology');
    await expect(dialog.getByLabel('Sector')).toHaveAccessibleDescription('Provider value: Technology');
    await dialog.getByLabel('Sector').fill('Invented Sector');
    await dialog.getByRole('button', { name: 'Save classification' }).click();
    await expect(dialog).toBeHidden();
    await expect(edit).toBeFocused();
    await expect(about.getByText('Edited by you')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Invented Sector');
    await expect(await openSectorAllocation(page)).toContainText('Invented Sector');

    await page.goBack();
    await page.getByRole('region', { name: /^About / }).getByRole('button', { name: 'Edit classification' }).click();
    await page.getByRole('dialog', { name: 'Edit classification of AAPL' }).getByRole('button', { name: 'Reset to automatic' }).click();
    await expect(page.getByRole('region', { name: /^About / }).getByText('Edited by you')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Technology');
  });

  test('saves a price history symbol upper-cased, refuses an invalid one and forgets it when emptied', async ({ page }) => {
    await page.goto('/assets/AAPL?portfolio=all');
    const open = async () => {
      await page.getByRole('region', { name: /^About / }).getByRole('button', { name: 'Edit classification' }).click();
      return page.getByRole('dialog', { name: 'Edit classification of AAPL' });
    };
    let dialog = await open();
    const input = dialog.getByLabel('Price history symbol');
    await expect(input).toHaveAccessibleDescription(/The suffix is the exchange: \.DE Xetra, \.AS Amsterdam, \.PA Paris, \.MI Milan, \.L London\. Leave empty for automatic\./);
    await input.fill('FWRA/DE');
    await expect(dialog.getByText(/Enter a symbol such as FWRA\.DE/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Save classification' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Price history symbol: Enter a symbol such as FWRA.DE');
    await input.fill('fwra.de');
    await dialog.getByRole('button', { name: 'Save classification' }).click();
    await expect(dialog).toBeHidden();

    dialog = await open();
    await expect(dialog.getByLabel('Price history symbol')).toHaveValue('FWRA.DE');
    await dialog.getByRole('button', { name: 'Reset to automatic' }).click();
    await expect(dialog).toBeHidden();
    dialog = await open();
    await expect(dialog.getByLabel('Price history symbol')).toHaveValue('');
  });

  for (const width of [1440, 390, 320]) {
    test(`the preview and the edit dialog fit a ${width}px wide screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/assets');
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.getByRole('button', { name: 'Import classification from Snowball' }).click();
      const dialog = page.getByRole('dialog', { name: 'Import asset classification' });
      await dialog.getByLabel('Snowball Holdings CSV').setInputFiles({ name: 'holdings.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') });
      const preview = dialog.getByRole('table', { name: 'Import preview' });
      await expect(preview).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      // The table itself fits its container: nothing has to scroll sideways.
      expect(await preview.evaluate((table) => table.scrollWidth - (table.parentElement?.clientWidth ?? 0))).toBeLessThanOrEqual(0);
      expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      await page.keyboard.press('Escape');

      await page.goto('/assets/AAPL?portfolio=all');
      await page.getByRole('region', { name: /^About / }).getByRole('button', { name: 'Edit classification' }).click();
      const edit = page.getByRole('dialog', { name: 'Edit classification of AAPL' });
      await expect(edit.getByLabel('Name')).toBeVisible();
      // The longest accepted symbol and its refusal text must wrap inside the dialog.
      await edit.getByLabel('Price history symbol').fill('A'.repeat(20));
      await expect(edit.getByLabel('Price history symbol')).toBeVisible();
      expect(await edit.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }
});
