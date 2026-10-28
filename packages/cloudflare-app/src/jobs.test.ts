import { BudgetGuard, MemoryItemStore, MemoryUsageStore, METRIC_LIMITS, silentLogger, type JobHandler, type JobPayloads, type UsageStore } from '@portfolio/platform';
import { parseEarningsRun, type TransactionsChangedDetail } from '@portfolio/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  CORE_JOB_FACTORIES,
  DEFERRED_CURSOR,
  JOB_SUBREQUEST_RESERVE,
  T212_QUOTE_SUBREQUESTS,
  PRICE_JOB_FACTORIES,
  PRICE_SCHEDULE_NAMES,
  createJobRegistry,
  eventsFor,
  guardedJob,
  hasPriceService,
  notifyAfterSync,
  priceJobDeps,
  registeredJobs,
  schedulesFor,
  EARNINGS_JOB_FACTORIES,
  type JobContext,
  type JobFactories,
} from './jobs.js';
import { DEFAULT_STEP_SUBREQUESTS } from '@portfolio/prices';
import { SUBREQUEST_CEILING, SubrequestBudget } from './subrequests.js';

const NOON = new Date(Date.UTC(2026, 0, 5, 12));
const hour = 3_600_000;
const sync = { all: true } as const;
const prices = { trigger: 'scheduled' } as const;

function setup(store: UsageStore = new MemoryUsageStore()) {
  const guard = new BudgetGuard({ store, now: () => NOON, logger: silentLogger });
  const budget = new SubrequestBudget(45);
  const options = { guard, budget, now: () => NOON };
  return { guard, budget, options };
}

const ran = () => vi.fn<JobHandler<never>>(() => Promise.resolve({ done: true as const, result: 'ran' }));
const use = (guard: BudgetGuard, percent: number) => guard.record({ workerRequests: (METRIC_LIMITS.workerRequests * percent) / 100 });

describe('guardedJob', () => {
  it('runs the job below the thresholds with its payload and cursor', async () => {
    const { options } = setup();
    const handler = ran();
    const job = guardedJob('syncBroker', handler as unknown as JobHandler<JobPayloads['syncBroker']>, options);
    expect(await job({ payload: sync, cursor: '{"x":1}' })).toEqual({ done: true, result: 'ran' });
    expect(handler).toHaveBeenCalledWith({ payload: sync, cursor: '{"x":1}' });
  });

  it('gives a job that was deferred before it started no cursor', async () => {
    const { options } = setup();
    const handler = ran();
    await guardedJob('syncBroker', handler as never, options)({ payload: sync, cursor: DEFERRED_CURSOR });
    expect(handler).toHaveBeenCalledWith({ payload: sync, cursor: undefined });
  });

  it('defers an essential job at 80 %: same cursor back, until the reset (re-checked at most hourly)', async () => {
    const { guard, options } = setup();
    await use(guard, 80);
    const handler = ran();
    const job = guardedJob('syncBroker', handler as never, options);
    expect(await job({ payload: sync })).toEqual({ done: false, next: DEFERRED_CURSOR, delayMs: hour });
    expect(await job({ payload: sync, cursor: '{"page":2}' })).toEqual({ done: false, next: '{"page":2}', delayMs: hour });
    expect(handler).not.toHaveBeenCalled();
  });

  it('waits only until the reset when it is closer than an hour', async () => {
    const guard = new BudgetGuard({ store: new MemoryUsageStore(), now: () => new Date(Date.UTC(2026, 0, 5, 23, 30)), logger: silentLogger });
    await use(guard, 90);
    const job = guardedJob('importUploaded', ran() as never, { guard, budget: new SubrequestBudget(), now: () => new Date(Date.UTC(2026, 0, 5, 23, 30)) });
    expect(await job({ payload: { userId: 'u', importId: 'i' } })).toMatchObject({ done: false, delayMs: 30 * 60_000 + 60_000 });
  });

  it('skips a non-essential job instead of failing it, at 60 % (priority) and at 80 % (blocked)', async () => {
    const { guard, options } = setup();
    const handler = ran();
    const job = guardedJob('refreshPrices', handler as never, options);
    expect(await job({ payload: prices })).toEqual({ done: true, result: 'ran' });
    await use(guard, 60);
    expect(await job({ payload: prices })).toEqual({ done: true, result: { skipped: 'deferred-by-priority' } });
    await use(guard, 25);
    expect(await job({ payload: prices })).toEqual({ done: true, result: { skipped: 'blocked' } });
    expect(handler).toHaveBeenCalledTimes(1); // only the call below the thresholds ran
  });

  it('runs the Trading 212 quote refresh in the warning band (60-80 %) but drops it, not defers it, once blocked', async () => {
    const { guard, options } = setup();
    const handler = ran();
    const job = guardedJob('refreshT212Quotes', handler as never, options);
    await use(guard, 70);
    expect(await job({ payload: { trigger: 'scheduled' } })).toEqual({ done: true, result: 'ran' });
    await use(guard, 10);
    expect(await job({ payload: { trigger: 'scheduled' } })).toEqual({ done: true, result: { skipped: 'blocked' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runs essential jobs in the warning band', async () => {
    const { guard, options } = setup();
    await use(guard, 70);
    const handler = ran();
    await guardedJob('syncBroker', handler as never, options)({ payload: sync });
    expect(handler).toHaveBeenCalled();
  });

  it('defers for five minutes while the ledger cannot be read, and skips non-essential jobs', async () => {
    const broken: UsageStore = { add: () => Promise.resolve(), read: () => Promise.reject(new Error('disk')), prune: () => Promise.resolve() };
    const { options } = setup(broken);
    const handler = ran();
    expect(await guardedJob('syncBroker', handler as never, options)({ payload: sync })).toEqual({ done: false, next: DEFERRED_CURSOR, delayMs: 300_000 });
    expect(await guardedJob('refreshCalendar', handler as never, options)({ payload: prices })).toEqual({ done: true, result: { skipped: 'store-unavailable' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('defers a step that needs more subrequests than are left, by a second, keeping the cursor', async () => {
    const { budget, options } = setup();
    const handler = ran();
    const job = guardedJob('syncBroker', handler as never, options);
    const wrapped = budget.wrap((() => Promise.resolve(new Response())) as typeof fetch);
    for (let call = 0; call < 45 - JOB_SUBREQUEST_RESERVE.syncBroker! + 1; call++) await wrapped('https://x.test/');
    expect(await job({ payload: sync, cursor: '{"a":1}' })).toEqual({ done: false, next: '{"a":1}', delayMs: 1000 });
    expect(await job({ payload: sync })).toEqual({ done: false, next: DEFERRED_CURSOR, delayMs: 1000 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs a job without a subrequest reserve however few calls are left', async () => {
    const { budget, options } = setup();
    const wrapped = budget.wrap((() => Promise.resolve(new Response())) as typeof fetch);
    for (let call = 0; call < 45; call++) await wrapped('https://x.test/');
    const handler = ran();
    await guardedJob('importUploaded', handler as never, options)({ payload: { userId: 'u', importId: 'i' } });
    expect(handler).toHaveBeenCalled();
  });
});

describe('the job registry and the price registration point', () => {
  const context = { budget: new SubrequestBudget(), now: () => NOON } as unknown as JobContext;

  it('registers the import, the Trading 212 sync and the three price jobs', () => {
    expect(registeredJobs().toSorted((a, b) => a.localeCompare(b))).toEqual(['backfillEarnings', 'enrichTransactions', 'fetchEarningsSummary', 'importUploaded', 'notifyDividends', 'refreshCalendar', 'refreshPrices', 'refreshT212Quotes', 'syncBroker', 'watchEarnings']);
    expect(Object.keys(PRICE_JOB_FACTORIES).toSorted((a, b) => a.localeCompare(b))).toEqual(['enrichTransactions', 'refreshCalendar', 'refreshPrices']);
    expect(hasPriceService()).toBe(true);
    expect(hasPriceService(CORE_JOB_FACTORIES)).toBe(false);
  });

  it('keeps the schedules of the registered jobs, the price service schedules among them', () => {
    expect(schedulesFor().map((schedule) => schedule.name).toSorted((a, b) => a.localeCompare(b))).toEqual(['broker-sync', 'broker-sync-intraday', 'earnings-backfill', 'earnings-watch', 'earnings-watch-morning', 'notify-dividends', 'prices-calendar', 'prices-refresh', 't212-quotes', 't212-quotes-close']);
    expect(schedulesFor(undefined, false).map((schedule) => schedule.name)).not.toContain('earnings-watch');
    expect(schedulesFor(undefined, false).map((schedule) => schedule.name)).not.toContain('earnings-watch-morning');
    expect(schedulesFor(undefined, false).map((schedule) => schedule.name)).not.toContain('earnings-backfill');
    expect(PRICE_SCHEDULE_NAMES.toSorted((a, b) => a.localeCompare(b))).toEqual(['prices-calendar', 'prices-refresh']);
    expect(schedulesFor(CORE_JOB_FACTORIES).map((schedule) => schedule.name)).toEqual(['broker-sync', 'broker-sync-intraday', 'notify-dividends', 't212-quotes', 't212-quotes-close']);
  });

  it('plans the quote refresh at 3 subrequests: one positions request and the two metadata requests', () => {
    expect(JOB_SUBREQUEST_RESERVE.refreshT212Quotes).toBe(T212_QUOTE_SUBREQUESTS);
    expect(T212_QUOTE_SUBREQUESTS).toBe(3);
    expect(CORE_JOB_FACTORIES.refreshT212Quotes).toBeDefined();
  });

  it('plans the earnings jobs well inside the alarm and drops them (not defers them) when the budget is denied', () => {
    expect(JOB_SUBREQUEST_RESERVE.watchEarnings).toBe(14);
    expect(JOB_SUBREQUEST_RESERVE.fetchEarningsSummary).toBe(8);
    expect(Math.max(JOB_SUBREQUEST_RESERVE.watchEarnings!, JOB_SUBREQUEST_RESERVE.fetchEarningsSummary!)).toBeLessThanOrEqual(SUBREQUEST_CEILING);
    expect(JOB_SUBREQUEST_RESERVE.backfillEarnings).toBe(8);
    expect(Object.keys(EARNINGS_JOB_FACTORIES)).toEqual(['watchEarnings', 'fetchEarningsSummary', 'backfillEarnings']);
  });

  it('plans a price step into the subrequests of an alarm', () => {
    for (const job of ['refreshPrices', 'enrichTransactions', 'refreshCalendar'] as const) {
      expect(JOB_SUBREQUEST_RESERVE[job]).toBe(DEFAULT_STEP_SUBREQUESTS);
      expect(JOB_SUBREQUEST_RESERVE[job]).toBeLessThanOrEqual(SUBREQUEST_CEILING);
    }
  });

  it('builds the price job dependencies from the Hub ports', () => {
    const items = {} as never;
    const deps = priceJobDeps({ items, fetch: vi.fn(), now: () => NOON, sleep: () => Promise.resolve(), config: { prices: { baseCurrency: 'EUR' } } } as unknown as JobContext);
    expect(deps).toMatchObject({ store: items, config: { baseCurrency: 'EUR' } });
    expect(deps.clock()).toEqual(NOON);
  });

  it('lets the price refresh start the enrichment of symbols that never had one, as a job on the Hub queue', async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    const deps = priceJobDeps({ ...context, queue: { enqueue }, items: {} as never, config: { prices: { baseCurrency: 'EUR' } } } as unknown as JobContext);
    await deps.enqueueEnrichment!(['SAP.DE', 'AAPL']);
    expect(enqueue).toHaveBeenCalledWith({ job: 'enrichTransactions', payload: { userId: '', portfolioId: '', reason: 'IMPORTED', symbols: ['SAP.DE', 'AAPL'] } });
  });

  it('builds a guarded handler for every registered factory, including a price job registered later', async () => {
    const { guard } = setup();
    const refresh = ran();
    const factories: JobFactories = { ...CORE_JOB_FACTORIES, refreshPrices: () => refresh as never, enrichTransactions: () => ran() as never };
    const registry = createJobRegistry({ ...context, items: {} as never }, { guard }, { refreshPrices: factories.refreshPrices, enrichTransactions: factories.enrichTransactions });
    expect(Object.keys(registry).toSorted((a, b) => a.localeCompare(b))).toEqual(['enrichTransactions', 'refreshPrices']);
    await registry.refreshPrices!({ payload: prices });
    expect(refresh).toHaveBeenCalledTimes(1);
    await use(guard, 80);
    expect(await registry.refreshPrices!({ payload: prices })).toEqual({ done: true, result: { skipped: 'blocked' } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('publishes events as enrichTransactions jobs only when a price service consumes them', async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    const detail: TransactionsChangedDetail = { userId: 'u', portfolioId: 'p', symbols: ['SAP.DE'], reason: 'CREATED' };
    await eventsFor({ enqueue }, CORE_JOB_FACTORIES).transactionsChanged(detail);
    expect(enqueue).not.toHaveBeenCalled();
    await eventsFor({ enqueue }).transactionsChanged(detail);
    expect(enqueue).toHaveBeenCalledWith({ job: 'enrichTransactions', payload: detail });
  });
});

describe('notifyAfterSync', () => {
  const result = (overrides: Record<string, unknown>) => ({ userId: 'u1', portfolioId: 'p1', status: 'SUCCEEDED', dryRun: false, counts: { written: 2 }, unmapped: [], warnings: [], symbols: {}, ...overrides });
  const finished = (...results: Record<string, unknown>[]) => (() => Promise.resolve({ done: true as const, result: { results } })) as never;
  const queue = () => ({ enqueue: vi.fn((_message: unknown) => Promise.resolve()) });

  it('enqueues the notification run once per user whose sync wrote transactions', async () => {
    const q = queue();
    const handler = notifyAfterSync(finished(result({}), result({ portfolioId: 'p2' }), result({ userId: 'u2', counts: { written: 1 } })), q);
    await handler({ payload: sync });
    expect(q.enqueue.mock.calls.map(([message]) => message)).toEqual([
      { job: 'notifyDividends', payload: { trigger: 'sync', userId: 'u1' } },
      { job: 'notifyDividends', payload: { trigger: 'sync', userId: 'u2' } },
    ]);
  });

  it.each([
    ['a sync that wrote nothing', result({ counts: { written: 0 } })],
    ['a sync without counts', result({ counts: undefined })],
    ['a dry run', result({ dryRun: true })],
    ['a failed sync', result({ status: 'FAILED' })],
    ['a skipped sync', result({ status: 'SKIPPED' })],
  ])('enqueues nothing for %s', async (_label, outcome) => {
    const q = queue();
    await notifyAfterSync(finished(outcome), q)({ payload: sync });
    expect(q.enqueue).not.toHaveBeenCalled();
  });

  it('waits for the last step of a resumable sync and passes steps through', async () => {
    const q = queue();
    const step = { done: false as const, next: 'cursor' };
    expect(await notifyAfterSync((() => Promise.resolve(step)) as never, q)({ payload: sync })).toBe(step);
    expect(q.enqueue).not.toHaveBeenCalled();
  });

  it('never fails the sync when the job cannot be enqueued', async () => {
    const q = { enqueue: vi.fn((_message: unknown) => Promise.reject(new Error('queue down'))) };
    const handler = notifyAfterSync(finished(result({})), q);
    await expect(handler({ payload: sync })).resolves.toMatchObject({ done: true });
  });
});

describe('the notification job', () => {
  it('is registered, reserves the subrequests of one user step and is dropped, not deferred, when the budget denies it', async () => {
    expect(registeredJobs()).toContain('notifyDividends');
    expect(JOB_SUBREQUEST_RESERVE.notifyDividends).toBe(30);
    const { guard, options } = setup();
    await use(guard, 80);
    const handler = ran();
    expect(await guardedJob('notifyDividends', handler as never, options)({ payload: { trigger: 'scheduled' } })).toEqual({ done: true, result: { skipped: 'blocked' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('is skipped until the keys are configured', async () => {
    const context = { items: {}, now: () => NOON, config: { push: { allowedHosts: [] }, baseCurrency: 'EUR', origin: 'https://x.test' }, fetch } as unknown as JobContext;
    const job = CORE_JOB_FACTORIES.notifyDividends!(context);
    expect(await job({ payload: { trigger: 'scheduled' } })).toMatchObject({ done: true, result: { skipped: 'not-configured' } });
  });
});

describe('the calendar job behind the budget guard', () => {
  const manual = { trigger: 'manual' } as const;

  it('runs an owner-requested refresh in the warning band, where the daily one gives way', async () => {
    const { guard, options } = setup();
    const handler = ran();
    const job = guardedJob('refreshCalendar', handler as never, options);
    await use(guard, 70);
    expect(await job({ payload: prices })).toEqual({ done: true, result: { skipped: 'deferred-by-priority' } });
    expect(await job({ payload: manual })).toEqual({ done: true, result: 'ran' });
    await use(guard, 15);
    expect(await job({ payload: manual })).toEqual({ done: true, result: { skipped: 'blocked' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reports a dropped job to onDropped, and a failure of the report changes nothing', async () => {
    const { guard, options } = setup();
    const onDropped = vi.fn(() => Promise.reject(new Error('store down')));
    const job = guardedJob('refreshCalendar', ran() as never, { ...options, onDropped });
    expect(await job({ payload: prices })).toEqual({ done: true, result: 'ran' });
    expect(onDropped).not.toHaveBeenCalled();
    await use(guard, 70);
    expect(await job({ payload: prices })).toEqual({ done: true, result: { skipped: 'deferred-by-priority' } });
    expect(onDropped).toHaveBeenCalledWith('refreshCalendar', prices, expect.objectContaining({ reason: 'deferred-by-priority' }));
  });

  it('records a dropped calendar run so the Diagnostics page can say why a date is missing, and ignores other dropped jobs', async () => {
    const { guard } = setup();
    const items = new MemoryItemStore();
    const registry = createJobRegistry({ budget: new SubrequestBudget(), now: () => NOON, items } as unknown as JobContext, { guard }, { refreshCalendar: () => ran() as never, refreshPrices: () => ran() as never });
    await use(guard, 70);
    await registry.refreshPrices!({ payload: prices });
    expect(items.snapshot()).toEqual([]);
    await registry.refreshCalendar!({ payload: prices });
    const record = parseEarningsRun(items.snapshot().find((item) => item.SK === 'EARNINGS#LASTRUN'));
    expect(record).toEqual({ at: NOON.toISOString(), trigger: 'scheduled', status: 'skipped', reason: expect.stringContaining('above 60%'), tracked: 0 });
    expect(items.snapshot().find((item) => item.SK === 'EARNINGS#LASTOK')).toBeUndefined();
    await use(guard, 15);
    await registry.refreshCalendar!({ payload: manual });
    expect(parseEarningsRun(items.snapshot().find((item) => item.SK === 'EARNINGS#LASTRUN'))).toMatchObject({ trigger: 'manual', status: 'skipped', reason: expect.stringContaining('used up') });
  });

  it('says when the budget ledger could not be read', async () => {
    const items = new MemoryItemStore();
    const failing: UsageStore = { ...new MemoryUsageStore(), read: () => Promise.reject(new Error('down')) } as unknown as UsageStore;
    const { guard } = setup(failing);
    const registry = createJobRegistry({ budget: new SubrequestBudget(), now: () => NOON, items } as unknown as JobContext, { guard }, { refreshCalendar: () => ran() as never });
    await registry.refreshCalendar!({ payload: prices });
    expect(parseEarningsRun(items.snapshot().find((item) => item.SK === 'EARNINGS#LASTRUN'))?.reason).toContain('ledger');
  });
});
