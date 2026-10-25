import { METRIC_LIMITS } from '@portfolio/platform';
import { createTestSubscriber } from '@portfolio/platform/testing';
import { GENERIC_RELEASE, REIT_RELEASE, type FixtureRelease } from '@portfolio/earnings/testing';
import { usageSnapshotSchema, type EarningsStatusResponse, type EarningsSummary } from '@portfolio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { Browser, type Stack } from './browser.js';
import type { EarningsStartOptions, StartStack } from './suite.js';

const CONTACT = 'PortfolioTracker/1.0 (personal use; owner@example.invalid)';
/** The pinned Hub clock (2026-01-05 12:00 UTC = 13:00 Amsterdam): the day the invented company reports, after the US close. */
const REPORT_DAY = '2026-01-05';
const dated = (release: FixtureRelease): FixtureRelease => ({ ...release, filingDate: REPORT_DAY });

const profile = (release: FixtureRelease, assetClass = 'STOCK') => ({ PK: `TICKER#${release.symbol}`, SK: 'PROFILE', entityType: 'PROFILE', symbol: release.symbol, name: release.name, assetClass, currency: 'USD', profileSource: 'provider' });
const calendarEvent = (release: FixtureRelease) => ({ PK: `TICKER#${release.symbol}`, SK: `EARN#${REPORT_DAY}`, entityType: 'EARNINGS_EVENT', symbol: release.symbol, date: REPORT_DAY, timeOfDay: 'AMC', source: 'test' });

/**
 * Earnings summaries through the whole stack: the calendar date of a held company passes, the watcher asks the (fake) SEC, the fake Workers AI
 * extracts, the figures are verified and stored, the API serves them and the push message reaches the (fake) push service encrypted to the
 * device. Written once, run in Node and in real workerd.
 */
export function defineEarningsSuite(label: string, start: StartStack): void {
  describe(`${label}: earnings summaries`, () => {
    const stacks: Stack[] = [];
    afterEach(async () => {
      await Promise.all(stacks.splice(0).map((stack) => stack.dispose()));
    });

    async function ownerOf(earnings: EarningsStartOptions) {
      const stack = await start({ limits: METRIC_LIMITS, earnings });
      stacks.push(stack);
      const owner = new Browser(stack);
      await owner.signIn();
      const call = async (method: string, path: string, requestBody?: unknown) => {
        const response = await owner.request(`/api${path}`, { method, ...(requestBody === undefined ? {} : { body: requestBody }) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
      };
      return { stack, call };
    }

    async function hold(stack: Stack, call: Awaited<ReturnType<typeof ownerOf>>['call'], release: FixtureRelease) {
      const portfolio = (await call('POST', '/portfolios', { name: `Earnings ${crypto.randomUUID().slice(0, 8)}` })).body.portfolioId as string;
      const buy = { portfolioId: portfolio, date: '2025-06-02', type: 'BUY', symbol: release.symbol, quantity: 10, price: 100, currency: 'USD' };
      expect((await call('POST', '/transactions', buy)).status).toBe(201);
      await stack.seed([profile(release), calendarEvent(release)]);
    }

    const settle = { ignoreJobs: ['enrichTransactions'] };

    it('turns a published release into a summary, announces it once, and never calls the SEC twice for it', async () => {
      const release = dated(GENERIC_RELEASE);
      const { stack, call } = await ownerOf({ releases: [release], contact: CONTACT, ai: true });
      await hold(stack, call, release);
      const device = await createTestSubscriber(`https://fcm.googleapis.com/fcm/send/earnings-${crypto.randomUUID()}`);
      expect((await call('POST', '/notifications/subscriptions', { ...device.subscription, label: 'Test phone' })).status).toBe(201);
      expect(stack.sec.requests).toEqual([]);

      await stack.enqueue('watchEarnings', { trigger: 'scheduled' });
      await stack.drain(settle);
      expect(await stack.failedJobs()).toEqual([]);

      const list = await call('GET', '/earnings');
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ available: true, symbols: ['LMFG'] });
      const summary = list.body.summaries[0] as EarningsSummary;
      expect(summary).toMatchObject({ symbol: 'LMFG', reportDate: REPORT_DAY, form: '8-K', origin: 'live', template: 'generic', reportingCurrency: 'USD' });
      expect(summary.filingUrl).toBe('https://www.sec.gov/Archives/edgar/data/1000101/000100010126000007/ex99_1.htm');
      expect(summary.headline.revenue).toMatchObject({ value: 4_820_000_000, yoyPct: 12 });
      expect(summary.headline.fcf).toMatchObject({ basis: 'calculated', value: 1_000_000_000 });
      expect(summary.verification).toMatchObject({ dropped: 0, calls: 1 });
      expect((await call('GET', `/earnings/LMFG/${REPORT_DAY}`)).body).toEqual(summary);

      // Every SEC request declared the owner's contact; nothing else was sent to the SEC.
      expect(stack.sec.requests.length).toBe(4);
      expect(stack.sec.requests.every((request) => request.userAgent === CONTACT)).toBe(true);

      // The neurons were counted in the usage ledger.
      const usage = usageSnapshotSchema.parse((await call('GET', '/usage')).body);
      expect(usage.metrics.aiNeurons.used).toBeGreaterThan(0);
      expect((await call('GET', '/earnings/status')).body).toMatchObject({ available: true, configured: true, neurons: { allowance: 10_000, dailyCap: 6000 } });

      // The push: encrypted to the device, the summary text, opens the page of the symbol.
      const messages = stack.push.to(device.subscription.endpoint);
      expect(messages).toHaveLength(1);
      const payload = await device.decrypt(messages[0]!.body);
      expect(payload).toMatchObject({ type: 'earnings', symbol: 'LMFG', url: '/earnings/LMFG' });
      expect(payload.title).toBe('Lumen Forge Technologies reported Q3 2026');
      expect(payload.body).toBe('Revenue $4.82B +12 % YoY · FCF/share $1.32');

      // Another watch and another notification run find nothing new.
      await stack.enqueue('watchEarnings', { trigger: 'scheduled' });
      await stack.enqueue('notifyDividends', { trigger: 'scheduled' });
      await stack.drain(settle);
      expect(stack.push.to(device.subscription.endpoint)).toHaveLength(1);
      expect(((await call('GET', '/earnings')).body.summaries as unknown[]).length).toBe(1);
      expect(await stack.failedJobs()).toEqual([]);
    });

    it('is off, not broken, without the SEC contact and the AI binding: it says so and sends nothing to the SEC', async () => {
      const release = dated(REIT_RELEASE);
      const { stack, call } = await ownerOf({ releases: [release] });
      await hold(stack, call, release);
      expect(await stack.schedules()).not.toContain('earnings-watch');
      expect(await stack.schedules()).not.toContain('earnings-backfill');
      await stack.enqueue('watchEarnings', { trigger: 'scheduled' });
      await stack.drain(settle);
      expect(stack.sec.requests).toEqual([]);
      expect(await stack.failedJobs()).toEqual([]);
      const status = await call('GET', '/earnings/status');
      expect(status.body).toMatchObject({ available: true, configured: false, missing: ['sec-contact', 'ai-binding'] });
      expect(status.body.symbols).toEqual([{ symbol: 'HSRT', eligible: true }]);
      const refresh = await call('POST', '/earnings/HSRT/refresh');
      expect([refresh.status, refresh.body.error.code]).toEqual([503, 'NOT_CONFIGURED']);
    });

    it('keeps the earnings watch schedules when configured, and an ETF has no earnings to look for', async () => {
      const release = dated(GENERIC_RELEASE);
      const { stack, call } = await ownerOf({ releases: [release], contact: CONTACT, ai: true });
      expect(await stack.schedules()).toEqual(expect.arrayContaining(['earnings-watch', 'earnings-watch-morning', 'earnings-backfill']));
      const portfolio = (await call('POST', '/portfolios', { name: `Fund ${crypto.randomUUID().slice(0, 8)}` })).body.portfolioId as string;
      expect((await call('POST', '/transactions', { portfolioId: portfolio, date: '2025-06-02', type: 'BUY', symbol: 'VWRL.AS', quantity: 1, price: 100, currency: 'EUR' })).status).toBe(201);
      await stack.seed([{ PK: 'TICKER#VWRL.AS', SK: 'PROFILE', entityType: 'PROFILE', symbol: 'VWRL.AS', name: 'World Fund', assetClass: 'ETF', currency: 'EUR', profileSource: 'provider' }]);
      await stack.enqueue('watchEarnings', { trigger: 'scheduled' });
      await stack.drain(settle);
      expect(stack.sec.requests).toEqual([]);
      const refresh = await call('POST', '/earnings/VWRL.AS/refresh');
      expect([refresh.status, refresh.body.error.code]).toEqual([422, 'NOT_ELIGIBLE']);
    });

    it('backfills the latest release of every holding silently, says what it checked, and "Fetch all now" is rate limited', async () => {
      const older = (release: FixtureRelease): FixtureRelease => ({ ...release, filingDate: '2025-12-10' });
      const releases = [older(GENERIC_RELEASE), older(REIT_RELEASE)];
      const { stack, call } = await ownerOf({ releases, contact: CONTACT, ai: true });
      for (const release of releases) await hold(stack, call, release);
      const device = await createTestSubscriber(`https://fcm.googleapis.com/fcm/send/backfill-${crypto.randomUUID()}`);
      expect((await call('POST', '/notifications/subscriptions', { ...device.subscription, label: 'Test phone' })).status).toBe(201);

      await stack.enqueue('backfillEarnings', { trigger: 'scheduled' });
      await stack.drain(settle);
      expect(await stack.failedJobs()).toEqual([]);

      const list = await call('GET', '/earnings');
      expect(list.body.symbols).toEqual(['HSRT', 'LMFG']);
      expect((list.body.summaries as EarningsSummary[]).map((summary) => [summary.symbol, summary.reportDate, summary.origin]).toSorted()).toEqual([['HSRT', '2025-12-10', 'backfill'], ['LMFG', '2025-12-10', 'backfill']]);
      const status = (await call('GET', '/earnings/status')).body as EarningsStatusResponse;
      expect(status.backfill).toMatchObject({ status: 'complete', quarters: 4, total: 2, done: 2, stored: 2, failed: 0 });
      expect(status.symbols.map((entry) => [entry.symbol, entry.lastRun?.stage, entry.lastRun?.filing?.date])).toEqual([['HSRT', 'ok', '2025-12-10'], ['LMFG', 'ok', '2025-12-10']]);
      expect(status.lastFullPassAt).toBeDefined();
      expect(stack.push.to(device.subscription.endpoint)).toHaveLength(0);

      const requests = stack.sec.requests.length;
      await stack.enqueue('backfillEarnings', { trigger: 'scheduled' });
      await stack.drain(settle);
      expect(stack.sec.requests).toHaveLength(requests);

      const all = await call('POST', '/earnings/backfill');
      expect([all.status, all.body]).toEqual([202, { accepted: true }]);
      await stack.drain(settle);
      expect(await stack.failedJobs()).toEqual([]);
      const again = await call('POST', '/earnings/backfill');
      expect([again.status, again.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    });

    it('queues an owner-triggered re-check once an hour per symbol', async () => {
      const release = dated(GENERIC_RELEASE);
      const { stack, call } = await ownerOf({ releases: [release], contact: CONTACT, ai: true });
      await hold(stack, call, release);
      const first = await call('POST', '/earnings/LMFG/refresh');
      expect([first.status, first.body]).toEqual([202, { accepted: true }]);
      await stack.drain(settle);
      expect(((await call('GET', '/earnings')).body.summaries as unknown[]).length).toBe(1);
      const second = await call('POST', '/earnings/LMFG/refresh');
      expect([second.status, second.body.error.code]).toEqual([429, 'RATE_LIMITED']);
      expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
    });
  });
}
