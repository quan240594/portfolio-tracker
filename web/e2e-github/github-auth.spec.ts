import { expect, test, type Page, type Route } from '@playwright/test';
import { settledCount } from '../e2e/settled';

const OWNER = 'octo-owner';
const NOW = new Date('2026-10-15T10:00:00Z');

const SUMMARY = {
  baseCurrency: 'EUR',
  totalValue: 12345.67,
  totalCost: 10000,
  unrealizedPnl: 2345.67,
  unrealizedPnlPct: 0.2345,
  currencyEffect: -12.34,
  realizedPnl: 100,
  dividendsReceived: 50,
  totalReturn: 2495.67,
  totalReturnPct: 0.2495,
  dayChange: 23.45,
  dayChangePct: 0.0019,
  holdingsCount: 2,
  asOf: '2026-10-15T08:00:00Z',
};

const holding = (symbol: string, name: string, marketValue: number) => ({
  symbol,
  name,
  assetClass: 'ETF',
  sector: 'Diversified',
  country: 'IE',
  currency: 'EUR',
  quantity: 10,
  averageCostLocal: 90,
  priceLocal: 100,
  averageCostBase: 90,
  priceBase: 100,
  priceStale: false,
  costBasis: 900,
  marketValue,
  unrealizedPnl: marketValue - 900,
  unrealizedPnlPct: marketValue / 900 - 1,
  currencyEffect: 0,
  dayChange: 1,
  dayChangePct: 0.001,
  realizedPnl: 0,
  dividendsReceived: 0,
  weight: 0.5,
});

const API_BODIES: Record<string, unknown> = {
  '/api/portfolios': { portfolios: [] },
  '/api/portfolio': SUMMARY,
  '/api/holdings': { baseCurrency: 'EUR', holdings: [holding('VWCE', 'World ETF', 1000), holding('AGGH', 'Bond ETF', 1000)] },
  '/api/history': { range: '1Y', baseCurrency: 'EUR', points: [] },
  '/api/allocation': { by: 'assetClass', baseCurrency: 'EUR', slices: [] },
};

interface Worker {
  signedIn: boolean;
  sessionChecks: number;
  logouts: number;
  apiRequests: { path: string; authorization: string | undefined }[];
  loginTargets: string[];
}

/** Stands in for the Worker: /auth/* and /api/* on the SPA's own origin (the cookie is simulated by `signedIn`). */
async function mockWorker(page: Page, { signedIn = false }: { signedIn?: boolean } = {}): Promise<Worker> {
  const worker: Worker = { signedIn, sessionChecks: 0, logouts: 0, apiRequests: [], loginTargets: [] };
  // Match on the pathname only: Vite also serves source files such as /src/api/client.ts.
  const isPath = (prefix: string) => (url: URL) => url.pathname.startsWith(prefix);

  await page.route(isPath('/auth/'), (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/auth/session') {
      worker.sessionChecks++;
      return route.fulfill({
        json: worker.signedIn ? { authenticated: true, login: OWNER } : { authenticated: false },
        headers: { 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/auth/login') {
      const returnTo = url.searchParams.get('returnTo') ?? '/';
      worker.loginTargets.push(returnTo);
      worker.signedIn = true; // GitHub redirected back and the Worker set the cookie
      return route.fulfill({ status: 302, headers: { location: returnTo } });
    }
    if (url.pathname === '/auth/logout' && route.request().method() === 'POST') {
      worker.logouts++;
      worker.signedIn = false;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404 });
  });

  await page.route(isPath('/api/'), (route: Route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    worker.apiRequests.push({ path: pathname, authorization: request.headers().authorization });
    if (!worker.signedIn) return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'Sign in required' } } });
    const body = API_BODIES[pathname];
    if (body === undefined) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
    return route.fulfill({ json: body });
  });
  return worker;
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const signInLink = (page: Page) => page.getByRole('link', { name: 'Sign in with GitHub' });
const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const totalValue = (page: Page) => page.getByRole('region', { name: 'Total value', exact: true }).getByTestId('kpi-value');

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

test.describe('Portfolio Tracker (GitHub sign-in build)', () => {
  test('signed out: shows only the sign-in screen, calls no API and never shows the demo banner', async ({ page }) => {
    const worker = await mockWorker(page);
    await page.goto('/holdings?x=1#top');
    await expect(heading(page, 'Sign in')).toBeVisible();
    await expect(page).toHaveTitle(/Sign in · Portfolio Tracker/);
    await expect(signInLink(page)).toHaveAttribute('href', '/auth/login?returnTo=%2Fholdings%3Fx%3D1%23top');
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(page.getByText('Demo mode')).toHaveCount(0);
    await expect(page.getByText('Switch to real data')).toHaveCount(0);
    expect(worker.apiRequests).toEqual([]);
    expect(worker.sessionChecks).toBeGreaterThanOrEqual(1); // React StrictMode runs effects twice in the dev server
  });

  test('sign in -> app (cookie only, no bearer header) -> sign out', async ({ page }) => {
    const worker = await mockWorker(page);
    await page.goto('/holdings?x=1');
    await signInLink(page).click();

    await expect(heading(page, 'Holdings')).toBeVisible();
    await expect(page).toHaveURL(/\/holdings\?x=1$/);
    expect(worker.loginTargets).toEqual(['/holdings?x=1']);
    await expect(page.getByText('Demo mode')).toHaveCount(0);

    expect(await settledCount(page.getByRole('table').getByRole('rowheader'))).toBe(2);
    expect(worker.apiRequests.length).toBeGreaterThan(0);
    expect(worker.apiRequests.every((r) => r.authorization === undefined)).toBe(true);

    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByText(OWNER)).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(heading(page, 'Sign in')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    expect(worker.logouts).toBe(1);

    await page.reload();
    await expect(heading(page, 'Sign in')).toBeVisible();
  });

  test('an already signed-in owner goes straight to the dashboard', async ({ page }) => {
    const worker = await mockWorker(page, { signedIn: true });
    await page.goto('/');
    await expect(heading(page, 'Dashboard')).toBeVisible();
    await expect(totalValue(page)).toHaveText(/€\s[\d.]+,\d{2}$/);
    expect(worker.sessionChecks).toBeGreaterThanOrEqual(1); // React StrictMode runs effects twice in the dev server
  });

  test('an API 401 (expired session) returns to the sign-in screen with a notice', async ({ page }) => {
    const worker = await mockWorker(page, { signedIn: true });
    await page.goto('/');
    await expect(totalValue(page)).toBeVisible();

    worker.signedIn = false; // the cookie expired
    await page.getByRole('radio', { name: '3M' }).click(); // a fresh request

    await expect(heading(page, 'Sign in')).toBeVisible();
    await expect(page.getByText('Your session expired. Please sign in again.')).toBeVisible();
    await expect(signInLink(page)).toBeVisible();
  });

  test('a failing session check shows a retry, not the sign-in screen', async ({ page }) => {
    let failing = true;
    await page.route(
      (url) => url.pathname === '/auth/session',
      (route) => (failing ? route.fulfill({ status: 503, body: 'unavailable' }) : route.fulfill({ json: { authenticated: false } })),
    );
    await page.goto('/');
    await expect(heading(page, 'Could not check your sign-in')).toBeVisible();
    await expect(signInLink(page)).toHaveCount(0);
    failing = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(heading(page, 'Sign in')).toBeVisible();
  });

  for (const width of [320, 1280]) {
    test(`does not overflow horizontally at ${width}px (sign-in, app, account menu)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await mockWorker(page);
      await page.goto('/');
      await expect(signInLink(page)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await signInLink(page).click();
      await expect(totalValue(page)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await page.getByRole('button', { name: 'Account' }).click();
      await expect(page.getByText(OWNER)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(signInLink(page)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }
});
