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
