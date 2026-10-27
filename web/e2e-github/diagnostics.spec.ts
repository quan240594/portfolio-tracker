import { expect, test, type Page, type Route } from '@playwright/test';

// The alarm diagnostics page of the GitHub-sign-in build. The Worker is a route mock: nothing talks to a real deployment.
const NOW = new Date('2026-10-19T10:00:00Z');
const OWNER = 'octo-owner';
const T = Date.UTC(2026, 9, 19, 9, 30, 4);

test.use({ timezoneId: 'Europe/Amsterdam', locale: 'en-GB' });

const run = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  startedAt: T - id * 900_000,
  finishedAt: T - id * 900_000 + 850,
  durationMs: 850,
  retryCount: 0,
  isRetry: false,
  scheduledFor: T - id * 900_000,
  trigger: 'schedules: t212-quotes',
  outcome: 'completed',
  unfinished: false,
  jobs: [{ job: 'refreshT212Quotes', outcome: 'done', steps: 1, delayMs: null }],
  subrequests: 1,
  nextAlarmAt: T + 900_000,
  error: null,
  ...over,
});

const REPORT = {
  generatedAt: T + 60_000,
  armed: { alarmAt: T + 900_000, dueJobs: [], schedules: [{ name: 't212-quotes', nextRunAt: T + 900_000 }] },
  summary: { since: T - 86_400_000, runs: 3, completed: 1, deferred: 0, failed: 1, unfinished: 1, inProgress: 0, retries: 1, maxRetryCount: 1 },
  runs: [
    run(1, { finishedAt: null, durationMs: null, outcome: null, unfinished: true, jobs: [], subrequests: null, nextAlarmAt: null }),
    run(2, { outcome: 'failed', isRetry: true, retryCount: 1, jobs: [], error: { name: 'Error', message: 'a rather long error message that must wrap inside its cell instead of widening the page' } }),
    run(3),
  ],
  arms: [{ id: 1, at: T - 3_000_000, reason: 'job-enqueued', alarmAt: T - 3_000_000, runId: null }],
};

const row = (over: Record<string, unknown>) => ({
  provider: 'eodhd',
  eodRows: 252,
  eodRowsCapped: false,
  firstEod: '2025-10-23',
  lastEod: '2026-10-19',
  eodSources: ['eodhd'],
  proxyListing: null,
  historyOverride: null,
  firstTransaction: '2024-03-02',
  lastQuoteAt: '2026-10-19T08:15:00.000Z',
  lastQuoteSource: 't212',
  historyState: 'complete',
  lastAttempt: null,
  reason: 'Full history stored',
  ...over,
});

// A long name and a long error must wrap inside the card instead of widening the page.
const COVERAGE = {
  asOf: '2026-10-19T10:00:00.000Z',
  symbols: [
    row({ symbol: 'NOVO-B.CO', name: 'Novo Nordisk A/S Class B Shares (a rather long company name)', eodRows: 0, firstEod: null, lastEod: null, eodSources: [], lastQuoteAt: null, lastQuoteSource: null, historyState: 'missing', reason: 'No provider key for this exchange' }),
    row({
      symbol: 'IWDA.AS',
      name: 'iShares Core MSCI World UCITS ETF USD (Acc)',
      eodRows: 0,
      firstEod: null,
      lastEod: null,
      eodSources: [],
      lastQuoteAt: null,
      lastQuoteSource: null,
      historyState: 'missing',
      historyOverride: { symbol: 'IWDA.L', status: 'refused', reason: 'history symbol is quoted in GBP, the holding in EUR' },
      reason: 'History symbol set by you: IWDA.L. Not used: history symbol is quoted in GBP, the holding in EUR',
    }),
    row({
      symbol: 'MSFT',
      name: 'Microsoft',
      provider: 'twelvedata',
      eodRows: 40,
      firstEod: '2026-09-01',
      historyState: 'partial',
      eodSources: ['provider', 't212'],
      lastAttempt: { day: '2026-10-18', attempts: 2, outcome: 'retry', error: 'Daily credits exhausted, a rather long error message that must wrap inside its cell instead of widening the page' },
      reason: 'Daily quota used up, retries after reset',
    }),
    row({ symbol: 'ASML.AS', name: 'ASML Holding' }),
    row({ symbol: 'FWRA.MI', name: 'Invesco FTSE All-World Acc', eodSources: ['eodhd:FWRA.DE'], proxyListing: 'FWRA.DE', historyOverride: { symbol: 'FWRA.DE', status: 'applied', reason: null }, reason: 'History symbol set by you: FWRA.DE' }),
    row({ symbol: 'VWCE.DE', name: 'Vanguard FTSE All-World Acc', eodSources: ['eodhd:VWCE.AS'], proxyListing: 'VWCE.AS', reason: 'History from another listing of the same fund (Amsterdam); prices can differ by a few tenths of a percent' }),
  ],
  totals: { held: 6, complete: 3, partial: 1, missing: 2, valuedAtCostSince: '2026-01-05', valuedAtCostUntil: '2026-10-19', truncated: false },
  rowsRead: 330,
};

const line = (over: Record<string, unknown>) => ({
  units: 10,
  currency: 'USD',
  price: 200,
  priceCurrency: 'USD',
  priceDate: '2026-10-18',
  ageDays: 1,
  source: 'close',
  fxRate: 1.1,
  fxDate: '2026-10-16',
  fxFallback: 'none',
  value: 1818.18,
  fair: 1818.18,
  gap: 0,
  today: 1900,
  flags: [],
  ...over,
});

// A long symbol and many flags must wrap inside the card instead of widening the page.
const VALUATION = {
  asOf: '2026-10-19T00:00:00.000Z',
  baseCurrency: 'EUR',
  headline: 64012.5,
  days: [
    { date: '2026-04-19', chartValue: 33000, positionsValue: 33000, extraValue: 0, invested: 40000, fairValue: 36000, gap: -3000, lines: [line({ symbol: 'AAPL' })] },
    {
      date: '2026-10-19',
      chartValue: 64012.5,
      positionsValue: 64012.5,
      extraValue: 0,
      invested: 55010,
      fairValue: 71000,
      gap: -6987.5,
      lines: [
        line({ symbol: 'IITU.L-A-RATHER-LONG-SYMBOL-NAME', units: 1400.123456, price: 52.1234, value: 6618.18, fair: 66.18, gap: 6552, flags: ['scale', 'carried', 'stale', 'currency', 'fx', 'cost'], today: 123456.78 }),
        line({ symbol: 'FWRA.MI', currency: 'EUR', priceCurrency: 'EUR', price: 9.5, priceDate: null, ageDays: null, source: 'cost', fxRate: 1, fxDate: null, value: 9500, fair: 11200, gap: -1700, flags: ['cost'] }),
      ],
    },
  ],
  fx: [{ currency: 'USD', fixings: 134, first: '2026-02-02', last: '2026-10-16', fallbackDays: 383 }],
  symbolsTotal: 2,
  truncated: false,
  rowsRead: 6620,
};

async function mockWorker(page: Page, { exposed = true }: { exposed?: boolean } = {}) {
  const asked: string[] = [];
  await page.route((url) => url.pathname.startsWith('/auth/'), (route: Route) => {
    if (new URL(route.request().url()).pathname === '/auth/session') return route.fulfill({ json: { authenticated: true, login: OWNER }, headers: { 'cache-control': 'no-store' } });
    return route.fulfill({ status: 404 });
  });
  await page.route((url) => url.pathname.startsWith('/api/'), (route: Route) => {
    const { pathname, search } = new URL(route.request().url());
    if (pathname === '/api/diagnostics/alarms') {
      asked.push(search);
      return exposed ? route.fulfill({ json: REPORT }) : route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
    }
    if (pathname === '/api/prices/status') return exposed ? route.fulfill({ json: { state: 'partial', sources: [], missingSecrets: [], message: '', t212Quotes: null, history: COVERAGE } }) : route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
    if (pathname === '/api/diagnostics/valuation') return exposed ? route.fulfill({ json: VALUATION }) : route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
    if (pathname === '/api/notifications') return route.fulfill({ json: { available: false, configured: false, settings: { types: { exDividend: true, declared: true, received: true }, exDividendDaysBefore: 2 }, devices: [], maxDevices: 10 } });
    if (pathname === '/api/portfolios') return route.fulfill({ json: { portfolios: [] } });
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });
  return asked;
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

for (const viewport of [
  { name: '1280 px', width: 1280, height: 900 },
  { name: '320 px', width: 320, height: 800 },
]) {
  test.describe(`Diagnostics at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('opens from the account menu and lists the runs, the 24-hour summary and the runs without a finish', async ({ page }) => {
      const asked = await mockWorker(page);
      await page.goto('/');
      await page.getByRole('button', { name: 'Account' }).click();
      await page.getByRole('link', { name: 'Diagnostics' }).click();

      await expect(page.getByRole('heading', { level: 1, name: 'Diagnostics' })).toBeVisible();
      await expect(page).toHaveURL(/\/settings\/diagnostics$/);
      await expect(page).toHaveTitle(/Diagnostics · Portfolio Tracker/);
      expect(asked[0]).toBe('?limit=1'); // the menu only checks that the endpoint exists

      const summary = page.getByRole('region', { name: 'Last 24 hours' });
      await expect(summary).toContainText('No finish');
      await expect(summary).toContainText('cut short by the platform');
      const table = page.getByRole('table', { name: 'Last 3 alarm runs, newest first' });
      await expect(table.getByRole('row')).toHaveCount(4);
      await expect(table).toContainText('19-10-2026, 11:15'); // 09:15 UTC in Amsterdam
      await expect(table.getByRole('row').nth(1)).toContainText('No finish');
      await expect(table.getByRole('row').nth(2)).toContainText('Retry 1');
      await expect(table.getByRole('row').nth(3)).toContainText('refreshT212Quotes: done');
      expect(asked).toContain('?limit=50');
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await page.getByRole('button', { name: 'Refresh' }).click();
      await expect.poll(() => asked.filter((search) => search === '?limit=50').length).toBeGreaterThanOrEqual(2);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('shows the price data coverage of the held symbols, with the state as text, and nothing sticking out', async ({ page }) => {
      await mockWorker(page);
      await page.goto('/settings/diagnostics#price-coverage');
      const card = page.getByRole('region', { name: 'Price data coverage' });
      await expect(card).toBeVisible();
      await expect(card).toContainText('6 held symbols: 3 complete, 1 partial, 2 missing.');
      await expect(card).toContainText('from 05-01-2026 until 19-10-2026');
      const symbols = card.getByRole('table').getByRole('row').filter({ has: page.getByRole('rowheader') });
      await expect(symbols).toHaveCount(6);
      await expect(symbols.nth(0)).toContainText('Missing');
      await expect(symbols.nth(1)).toContainText('Missing');
      await expect(symbols.nth(2)).toContainText('Partial');
      await expect(symbols.nth(3)).toContainText('Complete');
      await expect(symbols.nth(4)).toContainText('Complete');
      await expect(symbols.nth(5)).toContainText('Complete');
      await expect(card.getByText('No provider key for this exchange').locator('visible=true')).toBeVisible();
      await expect(card.getByText(/Daily credits exhausted/).locator('visible=true')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const box = await card.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    });
  });
}

for (const viewport of [
  { name: '1280 px', width: 1280, height: 900 },
  { name: '320 px', width: 320, height: 800 },
]) {
  test.describe(`Chart reconciliation at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('is read on request and lists the symbols with their facts as text, nothing sticking out', async ({ page }) => {
      await mockWorker(page);
      await page.goto('/settings/diagnostics');
      const card = page.getByRole('region', { name: 'Chart reconciliation' });
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: 'Show reconciliation' }).click();
      await expect(card.getByRole('group', { name: 'Day' }).getByRole('button')).toHaveCount(2);
      await expect(card).toContainText('Chart value');
      const table = card.getByRole('table');
      await expect(table.getByRole('rowheader')).toHaveCount(2);
      await expect(table.getByRole('rowheader').nth(0)).toContainText('IITU.L-A-RATHER-LONG-SYMBOL-NAME');
      await expect(table).toContainText('rescaled');
      await expect(table).toContainText('cost fallback');
      await expect(card).toContainText('USD: 134 fixings');
      await expect(card).toContainText('383 days use another day');
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const box = await card.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);

      await card.getByRole('group', { name: 'Day' }).getByRole('button').first().click();
      await expect(card.getByRole('group', { name: 'Day' }).getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('shows the history that comes from another listing of the same fund', async ({ page }) => {
      await mockWorker(page);
      await page.goto('/settings/diagnostics#price-coverage');
      const card = page.getByRole('region', { name: 'Price data coverage' });
      await expect(card.getByText(/History from another listing of the same fund \(Amsterdam\)/).locator('visible=true')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('shows the history symbol the owner set and the reason when it was refused', async ({ page }) => {
      await mockWorker(page);
      await page.goto('/settings/diagnostics#price-coverage');
      const card = page.getByRole('region', { name: 'Price data coverage' });
      await expect(card.getByText('History symbol set by you: FWRA.DE', { exact: true }).locator('visible=true')).toBeVisible();
      await expect(card.getByText(/History symbol set by you: IWDA\.L\. Not used: history symbol is quoted in GBP, the holding in EUR/).locator('visible=true')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const box = await card.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    });
  });
}

test('offers no Diagnostics entry on a deployment without the endpoint, and the page says it is not available', async ({ page }) => {
  await mockWorker(page, { exposed: false });
  await page.goto('/');
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Diagnostics' })).toHaveCount(0);
  await page.goto('/settings/diagnostics');
  await expect(page.getByRole('heading', { name: 'Diagnostics are not available' })).toBeVisible();
});
