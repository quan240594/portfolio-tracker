import { BudgetGuard, MemoryUsageStore, METRIC_LIMITS, silentLogger, type JobHandler, type JobPayloads, type UsageStore } from '@portfolio/platform';
import type { TransactionsChangedDetail } from '@portfolio/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  CORE_JOB_FACTORIES,
  DEFERRED_CURSOR,
  JOB_SUBREQUEST_RESERVE,
  PRICE_JOB_FACTORIES,
  PRICE_SCHEDULE_NAMES,
  createJobRegistry,
  eventsFor,
  guardedJob,
  hasPriceService,
  priceJobDeps,
  registeredJobs,
  schedulesFor,
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
    expect(registeredJobs().toSorted((a, b) => a.localeCompare(b))).toEqual(['enrichTransactions', 'importUploaded', 'refreshCalendar', 'refreshPrices', 'syncBroker']);
    expect(Object.keys(PRICE_JOB_FACTORIES).toSorted((a, b) => a.localeCompare(b))).toEqual(['enrichTransactions', 'refreshCalendar', 'refreshPrices']);
    expect(hasPriceService()).toBe(true);
    expect(hasPriceService(CORE_JOB_FACTORIES)).toBe(false);
  });

  it('keeps the schedules of the registered jobs, the price service schedules among them', () => {
    expect(schedulesFor().map((schedule) => schedule.name).toSorted((a, b) => a.localeCompare(b))).toEqual(['broker-sync', 'prices-calendar', 'prices-refresh']);
    expect(PRICE_SCHEDULE_NAMES.toSorted((a, b) => a.localeCompare(b))).toEqual(['prices-calendar', 'prices-refresh']);
    expect(schedulesFor(CORE_JOB_FACTORIES).map((schedule) => schedule.name)).toEqual(['broker-sync']);
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
