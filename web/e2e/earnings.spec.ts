import { expect, test, type Page } from '@playwright/test';
import { KPI_TEMPLATES, KPI_TEMPLATE_IDS } from '@portfolio/shared';
import { gotoViaNav } from './nav';

/** Names the elements that push the page wider than the viewport, so a failure says what overflowed. */
const overflowing = (page: Page) =>
  page.evaluate(() => {
    if (document.documentElement.scrollWidth <= window.innerWidth) return [];
    return [...document.querySelectorAll('body *')]
      .filter((el) => {
        if (el.getBoundingClientRect().right <= window.innerWidth + 0.5) return false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== 'visible') return false;
        }
        return true;
      })
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 70)} right=${Math.round(el.getBoundingClientRect().right)}`);
  });

for (const viewport of [
  { name: '1280 px', width: 1280, height: 900 },
  { name: '320 px', width: 320, height: 800 },
]) {
  test.describe(`Earnings summaries (mock mode, ${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('shows the invented bank and software summaries with scorecard, growth and details, without horizontal overflow', async ({ page }) => {
      await page.goto('/');
      await gotoViaNav(page, 'Earnings');
      await expect(page).toHaveURL(/\/earnings$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Earnings' })).toBeVisible();
      await expect(page).toHaveTitle(/Earnings · Portfolio Tracker/);

      const cards = page.getByRole('article');
      await expect(cards).toHaveCount(2);
      await expect(cards.nth(0).getByRole('heading', { level: 2 })).toContainText('Harbor Bancorp');
      await expect(cards.nth(1).getByRole('heading', { level: 2 })).toContainText('Cloudvale Software');

      // The scorecard is a table (stacked rows below 640 px), with the verdict as text and the missing estimate said in words.
      const bank = cards.nth(0);
      await expect(bank.getByRole('table')).toBeVisible();
      await expect(bank.getByText('In line').first()).toBeVisible();
      await expect(bank.getByText('Revenue: The data provider has no estimate for this figure')).toBeVisible();
      await expect(bank.getByText('Consensus: Alpha Vantage').first()).toBeVisible();
      await expect(bank.getByRole('list', { name: 'Growth' })).toContainText('EPS up 12%');
      await expect(bank.getByText('Source: SEC filing')).toBeVisible();
      await expect(bank.getByRole('link', { name: /Source: SEC filing/ })).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(bank.getByText('Bank figures')).toBeVisible();
      await expect(bank.getByText('Return on tangible common equity').or(bank.getByText('ROTCE')).first()).toBeVisible();
      await expect(bank.getByText('Cash flow')).toHaveCount(0);

      // The software template: RPO and retention, free cash flow with its basis, and the first-quarter note.
      const saas = cards.nth(1);
      await expect(saas.getByText('Software as a service figures')).toBeVisible();
      await expect(saas.getByText('Net revenue retention')).toBeVisible();
      await expect(saas.getByText('Annual recurring revenue').locator('xpath=ancestor::li')).toContainText('not disclosed');
      await expect(saas.getByText('reported', { exact: true }).first()).toBeVisible();
      await expect(saas.getByText(/first stored quarter/)).toBeVisible();
      await expect(saas.getByText('Beat/Miss').first()).toBeAttached();
      await expect(saas.getByText('(31 analysts)')).toBeVisible();
      await expect(saas.getByText(/^Beat by/).first()).toBeVisible();
      await expect(saas.getByText(/^Missed by/).first()).toBeVisible();

      // Native details: a closed section opens on click.
      const updates = bank.locator('details', { hasText: 'Key updates' });
      await expect(updates).not.toHaveAttribute('open', '');
      await updates.locator('summary').click();
      await expect(updates).toHaveAttribute('open', '');
      await expect(updates.getByText('Repurchased $1.5 billion of common stock')).toBeVisible();

      expect(await overflowing(page)).toEqual([]);
    });

    test('shows the EPS-only consensus of a free Alpha Vantage key: expected EPS with its source, revenue n/a with one plan reason, no overflow', async ({ page }) => {
      await page.addInitScript(() => sessionStorage.setItem('earnings-demo-eps-only', 'on'));
      await page.goto('/earnings');
      const cards = page.getByRole('article');
      await expect(cards).toHaveCount(2);
      const bank = cards.nth(0);
      await expect(bank.getByText('Consensus: Alpha Vantage (EPS only, no analyst count)')).toBeVisible();
      await expect(bank.getByText('In line').first()).toBeVisible();
      await expect(bank.getByText('Revenue consensus is not available on the free data plan')).toHaveCount(1);
      await expect(bank.getByText(/retries automatically|limiting requests/)).toHaveCount(0);
      await expect(bank.getByText('Provider EPS basis may differ')).toHaveCount(0);
      const saas = cards.nth(1);
      await expect(saas.getByText('Provider EPS basis may differ')).toBeVisible();
      await expect(saas.getByText(/analysts\)/)).toHaveCount(0);
      expect(await overflowing(page)).toEqual([]);
    });

    test('filters by company with the chips and opens the page of one company', async ({ page }) => {
      await page.goto('/earnings');
      await expect(page.getByRole('article')).toHaveCount(2);
      await page.getByRole('navigation', { name: 'Filter by company' }).getByRole('link', { name: 'CLDV' }).click();
      await expect(page).toHaveURL(/\/earnings\/CLDV$/);
      await expect(page.getByRole('article')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Check CLDV now' })).toBeVisible();
      await expect(page).toHaveTitle(/CLDV · Earnings/);
      expect(await overflowing(page)).toEqual([]);
    });
  });
}

test.describe('Earnings summaries: every KPI template', () => {
  for (const viewport of [320, 1280]) {
    test(`renders the slots of each template without overflow at ${viewport} px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.addInitScript(() => sessionStorage.setItem('earnings-demo-templates', 'on'));
      await page.goto('/earnings');
      const cards = page.getByRole('article');
      await expect(cards).toHaveCount(KPI_TEMPLATE_IDS.length);
      for (const [index, template] of KPI_TEMPLATE_IDS.entries()) {
        const card = cards.nth(index);
        await expect(card.getByRole('heading', { level: 2 })).toContainText(`Template ${template} Company`);
        await expect(card.getByRole('table').first()).toBeVisible();
        for (const slot of KPI_TEMPLATES[template].slots) await expect(card.getByText(slot.label, { exact: true }).first()).toBeAttached();
        if (KPI_TEMPLATES[template].slots.length > 1) await expect(card.getByText('not disclosed').first()).toBeAttached();
      }
      expect(await overflowing(page)).toEqual([]);
    });
  }
});

test.describe('Earnings summaries: dividend and share buybacks', () => {
  for (const viewport of [320, 1280]) {
    test(`shows the dividend raise with the buyback, and N/A for the company without either, without overflow at ${viewport} px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.goto('/earnings');
      const cards = page.getByRole('article');
      await expect(cards).toHaveCount(2);

      const bank = cards.nth(0).getByRole('list', { name: 'Dividend and share buybacks' });
      await expect(bank.getByRole('listitem').nth(0)).toContainText('Dividend:');
      await expect(bank.getByRole('listitem').nth(0)).toContainText('raised 4,2%');
      await expect(bank.getByRole('listitem').nth(0)).toContainText('paid 27-11-2026 to holders of record 06-11-2026');
      await expect(bank.locator('svg[data-icon="up"]')).toBeAttached();
      await expect(bank.getByRole('listitem').nth(1)).toContainText('Share buybacks: repurchased $1.5B (24M shares) this quarter; $4.5B authorization remaining');

      const saas = cards.nth(1).getByRole('list', { name: 'Dividend and share buybacks' });
      await expect(saas.getByRole('listitem').nth(0)).toContainText('Dividend: N/A');
      await expect(saas.getByText('No dividend announced')).toBeVisible();
      await expect(saas.getByRole('listitem').nth(1)).toContainText('Share buybacks: N/A');
      expect(await overflowing(page)).toEqual([]);
    });

    test(`says "not read yet" for summaries stored before, and shows how far the pass that reads them again is at ${viewport} px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.addInitScript(() => sessionStorage.setItem('earnings-demo-unread', 'on'));
      await page.goto('/earnings');
      const cards = page.getByRole('article');
      await expect(cards).toHaveCount(2);
      for (const index of [0, 1]) await expect(cards.nth(index).getByRole('list', { name: 'Dividend and share buybacks' })).toContainText('Dividend and buyback: not read yet');
      await expect(page.getByRole('list', { name: 'Dividend and share buybacks' }).getByText('N/A')).toHaveCount(0);
      const section = page.locator('details', { hasText: 'What was checked' });
      await section.locator('summary').click();
      await expect(section.getByText(/Dividend and buyback: read for 3 of 8 stored quarters so far/)).toBeVisible();
      expect(await overflowing(page)).toEqual([]);
    });
  }
});

test.describe('Earnings summaries: what was checked', () => {
  for (const viewport of [320, 1280]) {
    test(`says why nothing is stored, company by company, without overflow at ${viewport} px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.addInitScript(() => sessionStorage.setItem('earnings-demo-empty', 'on'));
      await page.goto('/earnings');
      await expect(page.getByRole('heading', { name: 'No earnings summaries yet' })).toBeVisible();
      const section = page.locator('details', { hasText: 'What was checked' });
      await expect(section).toHaveAttribute('open', '');
      await expect(section.getByText('CLDV: found 8-K from 21-10-2026, the AI could not read it (invalid JSON)')).toBeVisible();
      await expect(section.getByText('HBRB: no results release in the last 135 days')).toBeVisible();
      await expect(section.getByText(/^NRDV\.AS: not found in the SEC company list/)).toBeVisible();
      await expect(section.getByText(/^Last full pass: every company was looked at since 25-10-2026/)).toBeVisible();
      await expect(section.getByText(/3 of 12 releases read/)).toBeVisible();
      await expect(section.getByText(/Resumes at 00:00 UTC/)).toBeVisible();
      await expect(section.getByText(/^Consensus estimates: 0 of 3 companies\. The free Alpha Vantage plan does not include estimates; not asked again before/)).toBeVisible();
      await expect(section.getByText(/^NRDV\.AS: .* · estimates: not covered by the data provider/)).toBeVisible();
      await expect(section.getByRole('button', { name: 'Fetch all now' })).toBeVisible();
      await section.getByRole('button', { name: 'Fetch all now' }).click();
      await expect(section.getByText(/Started\. The page fills as releases are read/)).toBeVisible();
      expect(await overflowing(page)).toEqual([]);
    });

    test(`keeps the section closed under the cards and opens it on click at ${viewport} px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.goto('/earnings');
      await expect(page.getByRole('article')).toHaveCount(2);
      const section = page.locator('details', { hasText: 'What was checked' });
      await expect(section).not.toHaveAttribute('open', '');
      await section.locator('summary').click();
      await expect(section.getByText(/8 of 8 releases read/)).toBeVisible();
      await expect(section.getByText('Consensus estimates: 2 of 2 companies.')).toBeVisible();
      expect(await overflowing(page)).toEqual([]);
    });

    test(`says EPS estimates and that revenue needs a paid plan when the key cannot read the estimates, at ${viewport} px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.addInitScript(() => sessionStorage.setItem('earnings-demo-eps-only', 'on'));
      await page.goto('/earnings');
      const section = page.locator('details', { hasText: 'What was checked' });
      await section.locator('summary').click();
      await expect(section.getByText('EPS estimates: 2 of 2 companies (revenue estimates need a paid plan).')).toBeVisible();
      expect(await overflowing(page)).toEqual([]);
    });
  }
});
