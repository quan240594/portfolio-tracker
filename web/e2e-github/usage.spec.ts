import { expect, test, type Page, type Route } from '@playwright/test';
import { settledCount } from '../e2e/settled';

// The free-plan usage indicator of the personal Cloudflare deployment. Same GitHub-mode build as github-auth.spec.ts:
// /auth/* and /api/* (including /api/usage) are route mocks, so the "Worker" answers whatever each test needs.
const NOW = new Date('2026-10-19T10:00:00Z');

// A fixed zone makes the local reset time (00:00 UTC) reproducible: 02:00 on Tuesday 20 Oct (CEST).
test.use({ timezoneId: 'Europe/Amsterdam', locale: 'nl-NL' });

const metric = (limit: number, percent: number) => ({
  used: (limit * percent) / 100,
  limit,
  percent,
  state: ((): string => {
    if (percent >= 80) return 'blocked';
    return percent >= 60 ? 'warn' : 'ok';
  })(),
});

const snapshot = (state: 'ok' | 'warn' | 'blocked', percents: { worker: number; rowsRead: number }) => ({
  day: '2026-10-19',
  generatedAt: '2026-10-19T10:00:00.000Z',
  resetsAt: '2026-10-20T00:00:00.000Z',
  state,
  thresholds: { warnPercent: 60, blockPercent: 80 },
  metrics: {
    workerRequests: metric(100_000, percents.worker),
    durableObjectRequests: metric(100_000, 1),
    durableObjectGbSeconds: metric(13_000, 1),
    rowsRead: metric(5_000_000, percents.rowsRead),
    rowsWritten: metric(100_000, 1),
    aiNeurons: metric(10_000, 1),
    storageBytes: metric(1_000_000_000, 1),
  },
});

const OK = snapshot('ok', { worker: 12.5, rowsRead: 3 });
const WARN = snapshot('warn', { worker: 61, rowsRead: 72.5 });
const BLOCKED = snapshot('blocked', { worker: 61, rowsRead: 85 });

const holding = (symbol: string, name: string) => ({
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
  marketValue: 1000,
  unrealizedPnl: 100,
  unrealizedPnlPct: 0.11,
  currencyEffect: 0,
  dayChange: 1,
  dayChangePct: 0.001,
  realizedPnl: 0,
  dividendsReceived: 0,
  weight: 0.5,
});

const SUMMARY = {
  baseCurrency: 'EUR',
  totalValue: 2000,
  totalCost: 1800,
  unrealizedPnl: 200,
  unrealizedPnlPct: 0.11,
  currencyEffect: 0,
  realizedPnl: 0,
  dividendsReceived: 0,
  totalReturn: 200,
  totalReturnPct: 0.11,
  dayChange: 2,
  dayChangePct: 0.001,
  holdingsCount: 2,
  asOf: '2026-10-19T08:00:00Z',
};

const API_BODIES: Record<string, unknown> = {
  '/api/portfolios': { portfolios: [] },
  '/api/portfolio': SUMMARY,
  '/api/holdings': { baseCurrency: 'EUR', holdings: [holding('VWCE', 'World ETF'), holding('AGGH', 'Bond ETF')] },
  '/api/history': { range: '1Y', baseCurrency: 'EUR', points: [] },
  '/api/allocation': { by: 'assetClass', baseCurrency: 'EUR', slices: [] },
};

interface Worker {
  /** What `GET /api/usage` answers; `undefined` = 404 like the AWS API. */
  usage: unknown;
  usageRequests: number;
  /** When true every API call except /api/usage is refused with 429 BUDGET_EXHAUSTED. */
  refuse: boolean;
}

/** Stands in for the Worker: a signed-in owner, the API bodies and the guard's behaviour. */
async function mockWorker(page: Page, init: Partial<Worker> = {}): Promise<Worker> {
  const worker: Worker = { usage: undefined, usageRequests: 0, refuse: false, ...init };
  const isPath = (prefix: string) => (url: URL) => url.pathname.startsWith(prefix);
  await page.route(isPath('/auth/'), (route: Route) =>
    route.fulfill({ json: { authenticated: true, login: 'octo-owner' }, headers: { 'cache-control': 'no-store' } }),
  );
  await page.route(isPath('/api/'), (route: Route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/usage') {
      worker.usageRequests++;
      if (worker.usage === undefined) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
      return route.fulfill({ json: worker.usage, headers: { 'cache-control': 'no-store' } });
    }
    if (worker.refuse) {
      return route.fulfill({
        status: 429,
        headers: { 'retry-after': '3600', 'cache-control': 'no-store' },
        json: { error: { code: 'BUDGET_EXHAUSTED', message: 'The free-plan budget is used up.', details: { blockedMetrics: ['rowsRead'] } } },
      });
    }
    const body = API_BODIES[pathname];
    if (body === undefined) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
    return route.fulfill({ json: body });
  });
  return worker;
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const chip = (page: Page, name: string) => page.getByRole('banner').getByRole('button', { name, exact: true });
const notice = (page: Page) => page.getByRole('complementary', { name: 'Free-plan usage' });
const panel = (page: Page) => page.getByRole('region', { name: 'Free-plan usage' });
const RESET = /02:00 \(00:00 UTC\)/;

test.beforeEach(async ({ page }) => {
  // Fake timers (still running in real time) so that the 5 minute poll can be fast-forwarded.
  await page.clock.install({ time: NOW });
});

test.describe('free-plan usage indicator (GitHub sign-in build)', () => {
  test('ok: a calm chip opens a keyboard accessible panel with every metric and closes with Escape', async ({ page }) => {
    await mockWorker(page, { usage: OK });
    await page.goto('/holdings');
    expect(await settledCount(page.getByRole('table').getByRole('rowheader'))).toBe(2);
    await expect(notice(page)).toHaveCount(0);

    const trigger = chip(page, 'Usage OK');
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeFocused();
    await expect(panel(page).getByRole('meter')).toHaveCount(7);
    const workers = panel(page).getByRole('meter', { name: 'Worker requests' });
    await expect(workers).toHaveAttribute('value', '12.5');
    await expect(workers.locator('xpath=ancestor::li')).toContainText('12.500 of 100.000 (12,5%)');
    await expect(panel(page)).toContainText('Free plan caps are never exceeded: at 80 % of any cap the app pauses new work until the reset.');
    await expect(panel(page)).toContainText(RESET);

    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('warn: an amber chip and a dismissible banner that stays dismissed for the session but returns when usage gets worse', async ({ page }) => {
    const worker = await mockWorker(page, { usage: WARN });
    await page.goto('/holdings');
    await expect(chip(page, 'Usage high')).toBeVisible();
    await expect(notice(page)).toContainText('Free-plan usage is getting high (Worker requests 61%, Database rows read 73%).');

    await notice(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice(page)).toHaveCount(0);
    await page.reload();
    await expect(chip(page, 'Usage high')).toBeVisible();
    await expect(notice(page)).toHaveCount(0);

    // The gentle poll (every 5 minutes) sees the worse state: the notice returns and cannot be dismissed.
    worker.usage = BLOCKED;
    await page.clock.fastForward('05:05');
    await expect(chip(page, 'Paused')).toBeVisible();
    await expect(notice(page)).toContainText('Paused to stay inside the free plan, resumes at');
    await expect(notice(page)).toContainText('02:00');
    await expect(notice(page).getByRole('button')).toHaveCount(0);
  });

  test('blocked: a calm persistent notice with the local resume time', async ({ page }) => {
    await mockWorker(page, { usage: BLOCKED });
    await page.goto('/');
    await expect(chip(page, 'Paused')).toBeVisible();
    await expect(notice(page)).toHaveText(/Paused to stay inside the free plan, resumes at \S+ 02:00\./);
    await expect(notice(page).getByRole('button')).toHaveCount(0);
  });

  test('a 429 BUDGET_EXHAUSTED answer shows "Paused" with the Retry-After time, not a generic failure', async ({ page }) => {
    await mockWorker(page, { refuse: true });
    await page.goto('/holdings');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Paused for now');
    // Retry-After 3600 s from the pinned 12:00 (Amsterdam) clock.
    await expect(alert).toContainText(/resumes at \S+ 13:00/);
    await expect(alert).not.toContainText('Could not load data');
    await expect(notice(page)).toContainText(/Paused to stay inside the free plan, resumes at \S+ 13:00/);
    // The usage endpoint is not part of the refusal: here it does not exist, so no chip.
    await expect(page.getByRole('banner').getByRole('button', { name: /^Usage|^Paused$/ })).toHaveCount(0);
  });

  test('no /usage endpoint (the AWS deployment): nothing is shown and it is not asked again', async ({ page }) => {
    const worker = await mockWorker(page);
    await page.goto('/holdings');
    expect(await settledCount(page.getByRole('table').getByRole('rowheader'))).toBe(2);
    await expect(page.getByRole('banner').getByRole('button', { name: /^Usage|^Paused$/ })).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(worker.usageRequests).toBe(1);
  });

  for (const width of [320, 1280]) {
    test(`does not overflow horizontally at ${width}px (chip, panel, warning and paused notices)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const worker = await mockWorker(page, { usage: WARN });
      await page.goto('/holdings');
      await expect(notice(page)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await chip(page, 'Usage high').click();
      await expect(panel(page)).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const box = await panel(page).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await page.keyboard.press('Escape');

      worker.usage = BLOCKED;
      await page.reload();
      await expect(notice(page)).toContainText('Paused to stay inside the free plan');
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }
});
