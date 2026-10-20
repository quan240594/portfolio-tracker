import { JOBS, MemoryItemStore, MemoryJobQueue, SCHEDULED_JOBS, type JobRegistry } from '@portfolio/platform';
import { describe, expect, it } from 'vitest';
import * as api from './index.js';
import { createMarketData } from './market.js';
import { FakeFetch } from './testing/fake-fetch.js';
import { NOW, NOW_SECONDS, harness, liveFake, tdQuote, track } from './testing/harness.js';

describe('createPriceJobs', () => {
  it('registers the three jobs of the Python service and finds their schedules in SCHEDULED_JOBS', () => {
    const h = harness();
    const jobs = api.createPriceJobs(h.deps);
    expect(Object.keys(jobs).toSorted()).toEqual([JOBS.enrichTransactions, JOBS.refreshCalendar, JOBS.refreshPrices].toSorted());
    expect(api.PRICE_JOB_NAMES).toEqual(['refreshPrices', 'enrichTransactions', 'refreshCalendar']);
    expect(api.PRICE_SCHEDULES.map((entry) => entry.name)).toEqual(['prices-refresh', 'prices-calendar']);
    expect(api.PRICE_SCHEDULES.every((entry) => SCHEDULED_JOBS.includes(entry))).toBe(true);
    expect(SCHEDULED_JOBS.filter((entry) => !api.PRICE_SCHEDULES.includes(entry)).map((entry) => entry.job)).toEqual([JOBS.syncBroker, JOBS.refreshT212Quotes, JOBS.refreshT212Quotes]);
  });

  it('runs on the in-memory job queue like on any adapter (continuations, results)', async () => {
    const fake = new FakeFetch()
      .add('frankfurter.dev/v1/latest', { base: 'EUR', date: '2026-10-13', rates: { USD: 1.16 } })
      .add('frankfurter.dev/v1/2026-10-01..2026-10-13', { base: 'EUR', rates: { '2026-10-01': { USD: 1.15 } } })
      .add('twelvedata.com/quote', tdQuote('AAPL', '230.12', '228.5'));
    const h = harness({ fake, stepSubrequests: 3 });
    track(h.store, 'AAPL');
    const queue = new MemoryJobQueue(api.createPriceJobs(h.deps) as JobRegistry);
    await queue.enqueue({ job: JOBS.refreshPrices, payload: { trigger: 'scheduled' } });
    await queue.drain();
    expect(queue.deadLetters).toEqual([]);
    expect(queue.results).toEqual([{ job: 'refreshPrices', result: expect.objectContaining({ refreshed: 1, fxUpdated: true, fxDaysWritten: 2 }) }]);
  });
});

describe('createMarketDataService', () => {
  it('runs refreshScheduled, enrichSymbols and refreshCalendar to completion at the given time', async () => {
    const fake = liveFake()
      .add('alphavantage.co', { text: 'symbol,name,reportDate\nAAPL,Apple,2026-10-29\n' })
      .add('eodhd.com/api/splits', [])
      .add('eodhd.com/api/div', [])
      .add('twelvedata.com/time_series', { meta: { currency: 'USD' }, values: [{ datetime: '2026-10-12', close: '1' }] });
    const h = harness({ fake });
    track(h.store, 'AAPL');
    const service = api.createMarketDataService(h.deps);

    const refreshed = await service.refreshScheduled(NOW);
    expect(refreshed).toMatchObject({ refreshed: 1, fxUpdated: true, euWindow: true });
    const calendar = await service.refreshCalendar(NOW);
    expect(calendar).toMatchObject({ tracked: 1, earnings: { status: 'ok', events: 1 }, corporateActions: { status: 'ok', checked: 1 } });
    const enriched = await service.enrichSymbols({ symbols: ['AAPL', 'cash.eur'] }, NOW);
    expect(enriched).toMatchObject({ symbols: 1, enriched: [] });
  });

  it('lets the clock follow the pauses of a paced job', async () => {
    const symbols = Array.from({ length: 10 }, (_, i) => `T${i}`);
    const fake = liveFake()
      .add('twelvedata.com/quote?symbol=T0', Object.fromEntries(symbols.slice(0, 8).map((s) => [s, tdQuote(s, '1', '1')])))
      .add('twelvedata.com/quote?symbol=T8', Object.fromEntries(symbols.slice(8).map((s) => [s, tdQuote(s, '1', '1')])));
    const h = harness({ fake });
    track(h.store, ...symbols);
    const summary = await api.createMarketDataService(h.deps).refreshScheduled(NOW);
    expect(summary.refreshed).toBe(10);
    expect(h.sleeps).toEqual([60_000]);
  });

  it('backfills the fixings from the day after the newest one, or from an explicit start', async () => {
    const fake = new FakeFetch()
      .add('frankfurter.dev/v1/2026-10-08..2026-10-13', { base: 'EUR', rates: { '2026-10-08': { USD: 1.1 }, '2026-10-09': { USD: 1.1 } } })
      .add('frankfurter.dev/v1/2026-10-10..2026-10-13', { base: 'EUR', rates: {} })
      .add('frankfurter.dev/v1/2026-10-01..2026-10-13', { base: 'EUR', rates: { '2026-10-01': { USD: 1.1 } } });
    const h = harness({ fake });
    h.store.load([{ PK: 'FX#EUR', SK: 'DAY#2026-10-07', entityType: 'FX_DAY', base: 'EUR', date: '2026-10-07', rates: { USD: 1 } }]);
    const service = api.createMarketDataService(h.deps);
    expect(await service.backfillFxHistory('2026-10-13')).toEqual({ base: 'EUR', start: '2026-10-08', end: '2026-10-13', fxDaysWritten: 2, lastDay: '2026-10-09' });
    expect(await service.backfillFxHistory('2026-10-13')).toMatchObject({ start: '2026-10-10', fxDaysWritten: 0, lastDay: '2026-10-09' });
    expect(await service.backfillFxHistory('2026-10-13', '2026-10-01')).toMatchObject({ start: '2026-10-01', fxDaysWritten: 1, lastDay: '2026-10-09' });
    const fresh = harness({ fake });
    expect(await api.backfillFxHistory(fresh.deps, '2026-10-13')).toMatchObject({ start: '2026-10-01', lastDay: '2026-10-01' });
    const none = harness({ fake: new FakeFetch() });
    expect(await api.backfillFxHistory(none.deps, '2026-09-30')).toEqual({ base: 'EUR', start: '2026-10-01', end: '2026-09-30', fxDaysWritten: 0, lastDay: null });
  });
});

describe('createMarketData', () => {
  it('builds only the sources whose API key is configured', () => {
    const none = createMarketData(harness({ env: { TWELVEDATA_API_KEY: '', EODHD_API_KEY: '', COINGECKO_API_KEY: '', ALPHAVANTAGE_API_KEY: '' } }).deps);
    expect(none.earnings).toBeUndefined();
    expect(none.actions).toBeUndefined();
    const all = createMarketData(harness().deps);
    expect(all.earnings?.name).toBe('alphavantage');
    expect(all.actions?.name).toBe('eodhd');
    expect(all.fx.name).toBe('frankfurter');
    expect(all.provider.name).toBe('live');
  });

  it('exposes the public contract', () => {
    expect(Object.keys(api).toSorted()).toEqual(
      expect.arrayContaining(['createMarketDataService', 'createPriceJobs', 'createRefreshPricesJob', 'createEnrichTransactionsJob', 'createRefreshCalendarJob', 'createMarketData', 'parsePricesConfig', 'budgetedFetch', 'PriceRepository', 'RoutingProvider', 'FrankfurterFx', 'backfillFxHistory']),
    );
    expect(new MemoryItemStore().size).toBe(0);
    expect(NOW_SECONDS).toBeGreaterThan(0);
  });
});
