import { METRIC_LIMITS } from '@portfolio/platform';
import { createTestSubscriber } from '@portfolio/platform/testing';
import { GENERIC_RELEASE, REIT_RELEASE, type FixtureRelease } from '@portfolio/earnings/testing';
import { usageSnapshotSchema, type EarningsStatusResponse, type EarningsSummary } from '@portfolio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { Browser, type Stack } from './browser.js';
import { AV_KEY } from './fakes.js';
import type { EarningsStartOptions, StartStack, SuiteStartOptions } from './suite.js';

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

    async function ownerOf(earnings: EarningsStartOptions, extra: SuiteStartOptions = {}) {
      const stack = await start({ limits: METRIC_LIMITS, earnings, ...extra });
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
      return portfolio;
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

    it('checks and lists only what is held now: a position bought and sold out is neither read, listed nor counted', async () => {
      const older = (release: FixtureRelease): FixtureRelease => ({ ...release, filingDate: '2025-12-10' });
      const kept = older(GENERIC_RELEASE);
      const sold = older(REIT_RELEASE);
      const { stack, call } = await ownerOf({ releases: [kept, sold], contact: CONTACT, ai: true });
      await hold(stack, call, kept);
      const portfolio = await hold(stack, call, sold);
      expect((await call('POST', '/transactions', { portfolioId: portfolio, date: '2025-07-02', type: 'SELL', symbol: sold.symbol, quantity: 10, price: 110, currency: 'USD' })).status).toBe(201);

      await stack.enqueue('backfillEarnings', { trigger: 'scheduled' });
      await stack.drain(settle);
      expect(await stack.failedJobs()).toEqual([]);

      const list = await call('GET', '/earnings');
      expect(list.body.symbols).toEqual(['LMFG']);
      const status = (await call('GET', '/earnings/status')).body as EarningsStatusResponse;
      expect(status.symbols.map((entry) => entry.symbol)).toEqual(['LMFG']);
      expect(status.notHeld).toBe(1);
      expect(status.backfill).toMatchObject({ status: 'complete', total: 1, done: 1, stored: 1, planned: 1, companies: 1 });
      expect((await call('GET', `/earnings/${sold.symbol}/2025-12-10`)).status).toBe(404);
      expect((await call('POST', `/earnings/${sold.symbol}/refresh`)).status).toBe(404);
    });

    /** The shape of a real Alpha Vantage `EARNINGS_ESTIMATES` answer (strings with decimals, nulls, a year among the quarters), invented figures. */
    const consensusAnswer = (symbol: string) => ({
      symbol,
      estimates: [
        { date: '2026-12-31', horizon: 'fiscal year', eps_estimate_average: '8.1000', eps_estimate_analyst_count: '9.0000', revenue_estimate_average: '19000000000.00' },
        {
          date: '2026-03-31',
          horizon: 'fiscal quarter',
          eps_estimate_average: '2.1000',
          eps_estimate_high: '2.2000',
          eps_estimate_low: '2.0000',
          eps_estimate_analyst_count: '11.0000',
          eps_estimate_revision_down_trailing_7_days: null,
          revenue_estimate_average: '4900000000.00',
          revenue_estimate_high: '5000000000.00',
          revenue_estimate_low: '4800000000.00',
          revenue_estimate_analyst_count: '10.00',
        },
        {
          date: '2025-12-31',
          horizon: 'fiscal quarter',
          eps_estimate_average: '1.9000',
          eps_estimate_high: '2.0000',
          eps_estimate_low: '1.8000',
          eps_estimate_analyst_count: '12.0000',
          revenue_estimate_average: '4900000000.00',
          revenue_estimate_high: '5000000000.00',
          revenue_estimate_low: '4800000000.00',
          revenue_estimate_analyst_count: '10.00',
        },
      ],
    });

    it('fetches the analyst consensus of a held company within the Alpha Vantage allowance and joins it to the summary with beat or miss', async () => {
      const release = dated(GENERIC_RELEASE);
      const { stack, call } = await ownerOf({ releases: [release], contact: CONTACT, ai: true }, { prices: { ALPHAVANTAGE_API_KEY: AV_KEY } });
      await hold(stack, call, release);
      stack.sec.consensus.set('LMFG', consensusAnswer('LMFG'));
      expect(await stack.schedules()).toContain('earnings-estimates');

      await stack.enqueue('watchEarnings', { trigger: 'scheduled' });
      await stack.drain(settle);
      const before = (await call('GET', '/earnings')).body.summaries[0] as EarningsSummary;
      expect(before.consensus).toMatchObject({ provider: 'Alpha Vantage', reason: 'pending' });
      expect(before.consensus?.revenue).toBeUndefined();

      await stack.enqueue('earningsEstimates', { trigger: 'scheduled' });
      await stack.drain(settle);
      expect(await stack.failedJobs()).toEqual([]);
      expect(stack.sec.consensusRequests).toEqual(['LMFG']);

      const { consensus } = (await call('GET', '/earnings')).body.summaries[0] as EarningsSummary;
      expect(consensus).toMatchObject({ provider: 'Alpha Vantage', quarterEnd: '2025-12-31' });
      expect(consensus?.reason).toBeUndefined();
      expect(consensus?.eps).toMatchObject({ average: 1.9, high: 2, low: 1.8, analysts: 12, source: 'consensus', surprise: { amount: 0.08, pct: 4.2, verdict: 'beat' } });
      expect(consensus?.revenue).toMatchObject({ average: 4_900_000_000, analysts: 10, source: 'consensus', surprise: { amount: -80_000_000, pct: -1.6, verdict: 'miss' } });
      const status = (await call('GET', '/earnings/status')).body as EarningsStatusResponse;
      expect(status.consensus).toEqual({ covered: 1, companies: 1 });
      expect(status.symbols[0]?.consensus).toMatchObject({ outcome: 'ok' });

      // The company was fetched just now: the next run asks nobody.
      await stack.enqueue('earningsEstimates', { trigger: 'scheduled' });
      await stack.drain(settle);
      expect(stack.sec.consensusRequests).toEqual(['LMFG']);
      expect(await stack.failedJobs()).toEqual([]);
    });

    it('records a premium notice as its own outcome, says so on the summary and stops asking', async () => {
      const release = dated(GENERIC_RELEASE);
      const { stack, call } = await ownerOf({ releases: [release], contact: CONTACT, ai: true }, { prices: { ALPHAVANTAGE_API_KEY: AV_KEY } });
      await hold(stack, call, release);
      stack.sec.consensus.set('LMFG', { Information: 'Thank you for using Alpha Vantage! This is a premium endpoint. You may subscribe to any of the premium plans (https://www.alphavantage.co/premium/) to instantly unlock all premium endpoints' });
      await stack.enqueue('watchEarnings', { trigger: 'scheduled' });
      await stack.drain(settle);

      await stack.enqueue('earningsEstimates', { trigger: 'scheduled' });
      await stack.drain(settle);
      await stack.enqueue('earningsEstimates', { trigger: 'scheduled' });
      await stack.drain(settle);
      expect(stack.sec.consensusRequests).toEqual(['LMFG']);
      expect(await stack.failedJobs()).toEqual([]);

      const { consensus } = (await call('GET', '/earnings')).body.summaries[0] as EarningsSummary;
      expect(consensus?.reason).toBe('premium');
      expect(consensus?.revenue).toBeUndefined();
      const status = (await call('GET', '/earnings/status')).body as EarningsStatusResponse;
      expect(status.consensus).toMatchObject({ covered: 0, companies: 1, blockedReason: 'premium' });
      expect(status.symbols[0]?.consensus).toMatchObject({ outcome: 'premium' });
    });

    it('does not ask the provider without an Alpha Vantage key', async () => {
      const release = dated(GENERIC_RELEASE);
      const { stack, call } = await ownerOf({ releases: [release], contact: CONTACT, ai: true });
      await hold(stack, call, release);
      await stack.enqueue('earningsEstimates', { trigger: 'scheduled' });
      await stack.drain(settle);
      expect(stack.sec.consensusRequests).toEqual([]);
      expect(await stack.failedJobs()).toEqual([]);
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
