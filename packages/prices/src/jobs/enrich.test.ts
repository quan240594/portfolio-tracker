import type { TransactionsChangedDetail } from '@portfolio/shared';
import type { Item } from '@portfolio/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeFetch } from '../testing/fake-fetch.js';
import { NOW, NOW_SECONDS, drive, harness, tdQuote, type Harness } from '../testing/harness.js';
import { createEnrichTransactionsJob, enrichmentSymbols, quoteFromHistory } from './enrich.js';

afterEach(() => vi.restoreAllMocks());

const event = (symbols: unknown[]): TransactionsChangedDetail => ({ userId: 'u1', portfolioId: 'p1', reason: 'CREATED', symbols: symbols as string[] });
const stored = (store: Harness['store'], pk: string, sk: string): Item | undefined => store.snapshot().find((item) => item.PK === pk && item.SK === sk);
const items = (store: Harness['store'], pk: string, prefix: string): Item[] => store.snapshot().filter((item) => item.PK === pk && item.SK.startsWith(prefix));

const days = (count: number): { datetime: string; close: string }[] =>
  Array.from({ length: count }, (_, i) => ({ datetime: new Date(Date.UTC(2026, 9, 13 - (count - 1 - i))).toISOString().slice(0, 10), close: String(100 + i) }));

/** Typical answers for AAPL (Alpha Vantage, Twelve Data, EODHD dividends) and BTC-EUR (CoinGecko). */
function enrichFake(): FakeFetch {
  return new FakeFetch()
    .add('alphavantage.co', { Symbol: 'AAPL', AssetType: 'Common Stock', Name: 'Apple Inc.', Exchange: 'NASDAQ', Currency: 'USD', Country: 'USA', Sector: 'TECHNOLOGY', PERatio: '34.2' })
    .add('twelvedata.com/time_series', { meta: { currency: 'USD' }, values: days(5) })
    .add('twelvedata.com/quote', tdQuote('AAPL', '230.12', '228.5'))
    .add('eodhd.com/api/div/AAPL.US', [
      { date: '2024-11-10', paymentDate: '2024-11-14', value: 0.26, currency: 'USD' },
      { date: '2027-01-10', paymentDate: '2027-01-14', value: 0.27, currency: 'USD' },
      { date: '2020-01-10', value: 0.2 },
    ])
    .add('coingecko.com/api/v3/coins/bitcoin/market_chart', { prices: [[Date.UTC(2026, 9, 12), 60000], [Date.UTC(2026, 9, 13), 61000]] })
    .add('coingecko.com/api/v3/simple/price', { bitcoin: { eur: 61000, eur_24h_change: 0, last_updated_at: NOW_SECONDS } });
}

describe('enrichTransactions', () => {
  it('enriches only symbols without a profile, writes the PROFILE item last and is idempotent', async () => {
    const h = harness({ fake: enrichFake() });
    h.store.load([{ PK: 'TICKER#ASML.AS', SK: 'PROFILE', entityType: 'PROFILE', symbol: 'ASML.AS', name: 'ASML', assetClass: 'STOCK', currency: 'EUR' }]);
    const job = createEnrichTransactionsJob(h.deps);
    const { result } = await drive(h, job, event(['AAPL', 'asml.as', 'BTC-EUR', 'AAPL']));
    expect(result).toEqual({ symbols: 3, alreadyEnriched: 1, enriched: ['AAPL', 'BTC-EUR'], retry: [] });

    expect(stored(h.store, 'TICKER#AAPL', 'PROFILE')).toEqual({
      PK: 'TICKER#AAPL',
      SK: 'PROFILE',
      entityType: 'PROFILE',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      assetClass: 'STOCK',
      currency: 'USD',
      sector: 'Technology',
      country: 'United States',
      exchange: 'NASDAQ',
      peRatio: 34.2,
      fundamentalsAsOf: '2026-10-13',
      detailsAsOf: '2026-10-13',
    });
    expect(stored(h.store, 'TICKER#BTC-EUR', 'PROFILE')).toMatchObject({ name: 'Bitcoin', assetClass: 'CRYPTO', currency: 'EUR', detailsAsOf: '2026-10-13' });
    expect(stored(h.store, 'TICKER#BTC-EUR', 'PROFILE')).not.toHaveProperty('peRatio');
    expect(items(h.store, 'TICKER#AAPL', 'EOD#')).toHaveLength(5);
    expect(items(h.store, 'TICKER#AAPL', 'DIV#')).toEqual([
      { PK: 'TICKER#AAPL', SK: 'DIV#2024-11-10', entityType: 'DIVIDEND_EVENT', symbol: 'AAPL', exDate: '2024-11-10', payDate: '2024-11-14', amount: 0.26, currency: 'USD' },
      { PK: 'TICKER#AAPL', SK: 'DIV#2027-01-10', entityType: 'DIVIDEND_EVENT', symbol: 'AAPL', exDate: '2027-01-10', payDate: '2027-01-14', amount: 0.27, currency: 'USD' },
    ]);
    expect(stored(h.store, 'TICKER#AAPL', 'QUOTE#LATEST')).toMatchObject({ price: 230.12, source: 'twelvedata' });
    expect(stored(h.store, 'TRACKED', 'TICKER#BTC-EUR')).toEqual({ PK: 'TRACKED', SK: 'TICKER#BTC-EUR', entityType: 'TRACKED_TICKER', symbol: 'BTC-EUR', createdAt: '2026-10-13T16:30:00.000Z', updatedAt: '2026-10-13T16:30:00.000Z' });
    expect(stored(h.store, 'TICKER#ASML.AS', 'QUOTE#LATEST')).toBeUndefined();

    // Redelivery: nothing is fetched or changed.
    const before = h.store.snapshot();
    const calls = h.fake.urls.length;
    const again = await drive(h, job, event(['AAPL', 'BTC-EUR']));
    expect(again.result).toEqual({ symbols: 2, alreadyEnriched: 2, enriched: [], retry: [] });
    expect(h.fake.urls).toHaveLength(calls);
    expect(h.store.snapshot().filter((item) => item.PK !== 'USAGE')).toEqual(before.filter((item) => item.PK !== 'USAGE'));
  });

  it('keeps an existing TRACKED item untouched', async () => {
    const h = harness({ fake: enrichFake() });
    h.store.load([{ PK: 'TRACKED', SK: 'TICKER#BTC-EUR', entityType: 'TRACKED_TICKER', symbol: 'BTC-EUR' }]);
    await drive(h, createEnrichTransactionsJob(h.deps), event(['BTC-EUR']));
    expect(stored(h.store, 'TRACKED', 'TICKER#BTC-EUR')).not.toHaveProperty('createdAt');
  });

  it('retries transient failures in later rounds with a growing pause, then reports what still fails', async () => {
    const fake = enrichFake().add('twelvedata.com/quote', { status: 503 });
    const h = harness({ fake });
    const { result, steps } = await drive(h, createEnrichTransactionsJob(h.deps), event(['AAPL', 'BTC-EUR']));
    expect(result).toEqual({ symbols: 2, alreadyEnriched: 0, enriched: ['BTC-EUR'], retry: ['AAPL'] });
    expect(steps.flatMap((step) => (step.done ? [] : [step.delayMs]))).toEqual([60_000, 120_000]);
    expect(stored(h.store, 'TICKER#AAPL', 'PROFILE')).toBeUndefined();
  });

  it('succeeds in a later round once the provider recovers', async () => {
    const fake = enrichFake().add('twelvedata.com/quote', { status: 503 });
    const h = harness({ fake });
    const job = createEnrichTransactionsJob(h.deps);
    const first = await job({ payload: event(['AAPL']) });
    expect(first).toMatchObject({ done: false, delayMs: 60_000 });
    fake.add('twelvedata.com/quote', tdQuote('AAPL', '230.12', '228.5'));
    h.clock.advance(60_000);
    const second = await job({ payload: event(['AAPL']), cursor: first.done ? undefined : first.next });
    expect(second).toMatchObject({ done: true, result: { enriched: ['AAPL'], retry: [] } });
  });

  it('skips unknown symbols and symbols without a provider, storing nothing', async () => {
    const unknown = harness({ fake: enrichFake().add('twelvedata.com/time_series', { code: 404, status: 'error' }) });
    expect((await drive(unknown, createEnrichTransactionsJob(unknown.deps), event(['AAPL']))).result).toMatchObject({ enriched: [], retry: [] });
    expect(unknown.store.snapshot().filter((item) => item.PK !== 'USAGE')).toEqual([]);

    const nokey = harness({ fake: enrichFake(), env: { TWELVEDATA_API_KEY: '', ALPHAVANTAGE_API_KEY: '' } });
    expect((await drive(nokey, createEnrichTransactionsJob(nokey.deps), event(['AAPL', 'BTC-EUR']))).result).toMatchObject({ enriched: ['BTC-EUR'], retry: [] });
    expect(stored(nokey.store, 'TICKER#AAPL', 'PROFILE')).toBeUndefined();
  });

  it('skips a symbol with a permanent provider error and tolerates permanent dividend errors', async () => {
    const permanent = harness({ fake: enrichFake().add('twelvedata.com/time_series', { status: 400 }) });
    expect((await drive(permanent, createEnrichTransactionsJob(permanent.deps), event(['AAPL']))).result).toMatchObject({ enriched: [], retry: [] });

    const noDividends = harness({ fake: enrichFake().add('eodhd.com/api/div/AAPL.US', { status: 403 }) });
    expect((await drive(noDividends, createEnrichTransactionsJob(noDividends.deps), event(['AAPL']))).result).toMatchObject({ enriched: ['AAPL'] });
    expect(items(noDividends.store, 'TICKER#AAPL', 'DIV#')).toEqual([]);
  });

  it('retries a transient dividend failure and a storage failure', async () => {
    const dividends = harness({ fake: enrichFake().add('eodhd.com/api/div/AAPL.US', { status: 503 }) });
    expect((await drive(dividends, createEnrichTransactionsJob(dividends.deps), event(['AAPL']))).result).toMatchObject({ enriched: [], retry: ['AAPL'] });

    const storage = harness({ fake: enrichFake() });
    vi.spyOn(storage.store, 'batchWrite').mockRejectedValue(new Error('throttled'));
    expect((await drive(storage, createEnrichTransactionsJob(storage.deps), event(['AAPL']))).result).toMatchObject({ enriched: [], retry: ['AAPL'] });
  });

  it('falls back to the minimal profile and to a quote derived from the history', async () => {
    const fake = new FakeFetch()
      .add('eodhd.com/api/search/NOPROF', [])
      .add('eodhd.com/api/eod/NOPROF.AS', [{ date: '2026-10-12', close: 10 }, { date: '2026-10-13', close: 11 }])
      .add('eodhd.com/api/div/NOPROF.AS', [])
      .add('eodhd.com/api/real-time/NOPROF.AS', { status: 404 });
    const h = harness({ fake });
    const { result } = await drive(h, createEnrichTransactionsJob(h.deps), event(['NOPROF.AS']));
    expect(result.enriched).toEqual(['NOPROF.AS']);
    expect(stored(h.store, 'TICKER#NOPROF.AS', 'PROFILE')).toEqual({ PK: 'TICKER#NOPROF.AS', SK: 'PROFILE', entityType: 'PROFILE', symbol: 'NOPROF.AS', name: 'NOPROF.AS', assetClass: 'OTHER', currency: 'EUR', country: 'Netherlands', exchange: 'Euronext Amsterdam' });
    expect(stored(h.store, 'TICKER#NOPROF.AS', 'QUOTE#LATEST')).toMatchObject({ price: 11, previousClose: 10, source: 'live-eod', asOf: '2026-10-13T00:00:00.000Z' });
  });

  it('stores no quote when neither the provider nor the history has one', async () => {
    const fake = new FakeFetch().add('eodhd.com/api/search/EMPTY', []).add('eodhd.com/api/eod/EMPTY.AS', []).add('eodhd.com/api/div/EMPTY.AS', []).add('eodhd.com/api/real-time/EMPTY.AS', { status: 404 });
    const h = harness({ fake });
    expect((await drive(h, createEnrichTransactionsJob(h.deps), event(['EMPTY.AS']))).result.enriched).toEqual(['EMPTY.AS']);
    expect(stored(h.store, 'TICKER#EMPTY.AS', 'QUOTE#LATEST')).toBeUndefined();
  });

  it('paces Twelve Data: one US symbol per pause, other routes without waiting', async () => {
    const fake = enrichFake()
      .add('alphavantage.co', { Symbol: 'MSFT', Name: 'Microsoft', AssetType: 'Common Stock' })
      .add('twelvedata.com/quote?symbol=MSFT', tdQuote('MSFT', '400', '399'))
      .add('eodhd.com/api/div/MSFT.US', []);
    const h = harness({ fake });
    const { result, steps } = await drive(h, createEnrichTransactionsJob(h.deps), event(['AAPL', 'MSFT', 'BTC-EUR']));
    expect(result.enriched).toEqual(['AAPL', 'BTC-EUR', 'MSFT']);
    expect(steps.filter((step) => !step.done)).toEqual([expect.objectContaining({ delayMs: 30_000 })]);
  });

  it('continues in the next step when the budget runs out, and refuses a budget that can never be enough', async () => {
    const h = harness({ fake: enrichFake(), stepSubrequests: 4 });
    const { result, steps } = await drive(h, createEnrichTransactionsJob(h.deps), event(['AAPL', 'BTC-EUR']));
    expect(result.enriched).toEqual(['AAPL', 'BTC-EUR']);
    expect(steps.length).toBeGreaterThan(1);

    const tiny = harness({ fake: enrichFake(), stepSubrequests: 1 });
    await expect(createEnrichTransactionsJob(tiny.deps)({ payload: event(['AAPL']) })).rejects.toThrow('too small');
  });

  it('finishes at once without symbols and fails the step (for redelivery) when the profile lookup fails', async () => {
    const h = harness({ fake: enrichFake() });
    expect((await drive(h, createEnrichTransactionsJob(h.deps), event([]))).result).toEqual({ symbols: 0, alreadyEnriched: 0, enriched: [], retry: [] });
    expect(h.fake.requests).toEqual([]);
    vi.spyOn(h.store, 'getMany').mockRejectedValue(new Error('throttled'));
    await expect(createEnrichTransactionsJob(h.deps)({ payload: event(['AAPL']) })).rejects.toThrow('throttled');
  });

  it('only ever sees market symbols', () => {
    expect(enrichmentSymbols([' aapl ', '', 3, 'sap.de', 'CASH.EUR', 'CUSTOM:abc', 'AAPL', null])).toEqual(['AAPL', 'SAP.DE']);
    expect(NOW.getTime()).toBe(NOW_SECONDS * 1000);
  });

  it('derives a quote from the newest two EOD rows', () => {
    expect(quoteFromHistory('X', [], 'p')).toBeNull();
    expect(quoteFromHistory('X', [{ symbol: 'X', date: '2026-10-13', close: 5, currency: 'EUR' }], 'p')).toMatchObject({ price: 5, previousClose: 5, source: 'p-eod' });
  });
});
