import { expect, test, type Page } from '@playwright/test';

// Runs against the GitHub Pages build (see playwright.pages.config.ts): sub-path base + MSW demo mode + 404.html.
const BASE = '/portfolio-tracker/';

/** Collects console errors and uncaught page errors for the whole test. */
function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

// Chrome logs the 404 status of the deep-link document itself (served from 404.html) — expected on GitHub Pages.
const isExpectedDeepLink404 = (text: string) => /Failed to load resource: the server responded with a status of 404/.test(text);

async function expectDashboard(page: Page) {
  await expect(page).toHaveTitle(/Dashboard · Portfolio Tracker/);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  for (const label of ['Total value', 'Day change', 'Unrealized P&L', 'Total return']) {
    await expect(page.getByRole('region', { name: label, exact: true }).getByTestId('kpi-value')).toHaveText(
      /€\s[+\u2212]?[\d.]+,\d{2}$/,
    );
  }
}

async function expectDemoBanner(page: Page) {
  await expect(page.getByRole('complementary', { name: 'Demo mode' })).toContainText(
    'sample data, nothing is saved. Changes reset when you reload.',
  );
}

test.describe('GitHub Pages build (demo mode under /portfolio-tracker/)', () => {
  test('dashboard renders from mocks, nav works, and a reload on a deep link boots the app via 404.html', async ({ page }) => {
    const errors = trackErrors(page);
    const apiRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/')) apiRequests.push(req.url());
    });

    const res = await page.goto(BASE);
    expect(res?.status()).toBe(200);
    await expectDemoBanner(page);
    await expectDashboard(page);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', `${BASE}favicon.svg`);

    // The MSW worker is registered under the sub-path and controls the page.
    const sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { scope: reg?.scope, script: reg?.active?.scriptURL, controlled: !!navigator.serviceWorker.controller };
    });
    expect(sw.scope).toMatch(new RegExp(`${BASE}$`));
    expect(sw.script).toMatch(new RegExp(`${BASE}mockServiceWorker\\.js$`));
    expect(sw.controlled).toBe(true);

    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Holdings' })).toHaveAttribute('href', `${BASE}holdings`);
    await nav.getByRole('link', { name: 'Holdings' }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}holdings$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Holdings' })).toBeVisible();
    await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(8);

    // Hard reload on the deep link: Pages has no /holdings file, so it answers 404 with 404.html (= the SPA).
    const reloaded = await page.reload();
    expect(reloaded?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Holdings' })).toBeVisible();
    await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(8);
    await expectDemoBanner(page);

    // The router basename has no trailing slash, so the dashboard link is /portfolio-tracker (Pages 301s it to the
    // slash form on a full load — see the last test).
    await nav.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}?$`));
    await expectDashboard(page);

    expect(apiRequests.length).toBeGreaterThan(0);
    expect(errors.filter((e) => /service ?worker|mockServiceWorker|\[MSW\]/i.test(e))).toEqual([]);
    expect(errors.filter((e) => !isExpectedDeepLink404(e))).toEqual([]);
  });

  test('a cold visit straight to a deep link works', async ({ page }) => {
    const errors = trackErrors(page);
    const res = await page.goto(`${BASE}dividends`);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Dividends' })).toBeVisible();
    await expect(page).toHaveTitle(/Dividends · Portfolio Tracker/);
    await expectDemoBanner(page);
    expect(errors.filter((e) => !isExpectedDeepLink404(e))).toEqual([]);
  });

  test('mutations work in memory and reset on reload', async ({ page }) => {
    await page.goto(`${BASE}transactions`);
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible();
    await page.getByRole('button', { name: 'Add transaction' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add transaction' });
    await dialog.getByLabel('Type').selectOption('BUY');
    await dialog.getByLabel('Symbol').fill('sap.de');
    await dialog.getByLabel('Quantity').fill('4');
    await dialog.getByLabel('Price per unit').fill('201.35');
    await dialog.getByLabel('Currency').fill('EUR');
    await dialog.getByRole('button', { name: 'Save transaction' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('row').filter({ hasText: 'SAP.DE' })).toHaveCount(1);

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'SAP.DE' })).toHaveCount(0);
  });

  test('the bare project URL without trailing slash redirects into the app', async ({ page }) => {
    await page.goto(BASE.replace(/\/$/, ''));
    await expect(page).toHaveURL(new RegExp(`${BASE}$`));
    await expectDashboard(page);
  });
});
