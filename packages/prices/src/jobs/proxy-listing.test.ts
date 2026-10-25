import type { Item, ListingMatch } from '@portfolio/platform';
import type { TransactionsChangedDetail } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { FakeFetch } from '../testing/fake-fetch.js';
import { NOW_SECONDS, drive, harness, type Harness } from '../testing/harness.js';
import { createEnrichTransactionsJob } from './enrich.js';
import { chooseListing, PROXY_RETRY_DAYS } from './proxy-listing.js';

const ISIN = 'IE000000FWRA';
const event = (symbols: string[]): TransactionsChangedDetail => ({ userId: 'u1', portfolioId: 'p1', reason: 'CREATED', symbols });
const items = (store: Harness['store'], pk: string, prefix: string): Item[] => store.snapshot().filter((item) => item.PK === pk && item.SK.startsWith(prefix));
const stored = (store: Harness['store'], pk: string, sk: string): Item | undefined => store.snapshot().find((item) => item.PK === pk && item.SK === sk);

const listing = (symbol: string, exchange: string, currency: string, isin = ISIN): ListingMatch => ({ symbol, exchange, currency, isin, name: 'World fund' });

describe('chooseListing', () => {
  const wanted = { symbol: 'FWRA.MI', isin: ISIN, currency: 'EUR' };

  it('prefers XETRA, then Frankfurt, Amsterdam, Paris, Milan and London', () => {
    const all = [listing('FWRA.AS', 'AS', 'EUR'), listing('FWRA.PA', 'PA', 'EUR'), listing('FWRA.DE', 'DE', 'EUR'), listing('FWRA.F', 'F', 'EUR')];
    expect(chooseListing(all, wanted)).toBe('FWRA.DE');
    expect(chooseListing(all.filter((l) => l.exchange !== 'DE'), wanted)).toBe('FWRA.F');
    expect(chooseListing(all.filter((l) => l.exchange === 'PA' || l.exchange === 'AS'), wanted)).toBe('FWRA.AS');
    expect(chooseListing([listing('FWRA.MI', 'MI', 'EUR'), listing('FWRA.PA', 'PA', 'EUR')], { ...wanted, symbol: 'FWRA.AS' })).toBe('FWRA.PA');
  });

  it('never takes the held listing itself, another ISIN or another currency', () => {
    expect(chooseListing([listing('FWRA.MI', 'MI', 'EUR')], wanted)).toBeNull();
    expect(chooseListing([listing('FWRA.DE', 'DE', 'EUR', 'IE000000XXXX')], wanted)).toBeNull();
    expect(chooseListing([listing('FWRA.DE', 'DE', 'USD'), listing('FWRA.L', 'L', 'GBX')], wanted)).toBeNull();
  });

  it('takes a London listing for a pound position only when it is quoted in pence, and never one for a euro position', () => {
    const gbp = { symbol: 'VWRP.AS', isin: ISIN, currency: 'GBP' };
    expect(chooseListing([listing('VWRP.L', 'L', 'GBX')], gbp)).toBe('VWRP.L');
    expect(chooseListing([listing('VWRP.L', 'L', 'GBP')], gbp)).toBeNull();
    expect(chooseListing([listing('VWRP.L', 'L', 'USD')], gbp)).toBeNull();
    expect(chooseListing([listing('VWRP.L', 'L', 'GBX')], wanted)).toBeNull();
    expect(chooseListing([listing('VWRP.DE', 'DE', 'GBP')], gbp)).toBe('VWRP.DE');
  });
});

const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ date: `2026-10-${String(from + i).padStart(2, '0')}`, close: 100 + i }));

function proxyFake(): FakeFetch {
  return new FakeFetch()
    .add('eodhd.com/api/eod/FWRA.MI', { status: 404 })
    .add(`eodhd.com/api/search/${ISIN}`, [
      { Code: 'FWRA', Exchange: 'MI', Name: 'World fund', Currency: 'EUR', ISIN },
      { Code: 'FWRA', Exchange: 'LSE', Name: 'World fund', Currency: 'USD', ISIN },
      { Code: 'FWRA', Exchange: 'XETRA', Name: 'World fund', Currency: 'EUR', ISIN },
      { Code: 'OTHR', Exchange: 'AS', Name: 'Other fund', Currency: 'EUR', ISIN: 'IE000000OTHR' },
      { Code: 'FWRA', Exchange: 'NASDAQ', Name: 'Not served', Currency: 'EUR', ISIN },
    ])
    .add('eodhd.com/api/eod/FWRA.XETRA', rows(8, 12))
    .add('eodhd.com/api/div/', [])
    .add('eodhd.com/api/real-time/', { status: 404 });
}

const baseline = (extra: Record<string, unknown> = {}): Item => ({
  PK: 'TICKER#FWRA.MI',
  SK: 'PROFILE',
  entityType: 'PROFILE',
  symbol: 'FWRA.MI',
  name: 'World fund',
  assetClass: 'ETF',
  currency: 'EUR',
  isin: ISIN,
  profileSource: 'trading212',
  ...extra,
});

const calls = (fake: FakeFetch, part: string): number => fake.urls.filter((url) => url.includes(part)).length;

describe('history from another listing of the same fund', () => {
  it('stores the history of the preferred listing under the held symbol with the proxy as source, and remembers the choice', async () => {
    const fake = proxyFake();
    const h = harness({ fake });
    h.store.load([baseline()]);
    const { result } = await drive(h, createEnrichTransactionsJob(h.deps), event(['FWRA.MI']));
    expect(result).toMatchObject({ enriched: ['FWRA.MI'], retry: [] });
    const eod = items(h.store, 'TICKER#FWRA.MI', 'EOD#');
    expect(eod).toHaveLength(5);
    expect(eod[0]).toMatchObject({ symbol: 'FWRA.MI', currency: 'EUR', source: 'eodhd:FWRA.DE' });
    expect(items(h.store, 'TICKER#FWRA.DE', 'EOD#')).toEqual([]);
    expect(stored(h.store, `ISIN#${ISIN}`, 'PROXY')).toMatchObject({ currency: 'EUR', listing: 'FWRA.DE', checkedOn: '2026-10-13' });
    // the quote comes from the proxy history (the provider has no quote for the unknown symbol)
    expect(stored(h.store, 'TICKER#FWRA.MI', 'QUOTE#LATEST')).toMatchObject({ symbol: 'FWRA.MI', price: 104, source: 'live-eod' });
    expect(calls(fake, '/real-time/')).toBe(0);
    // counted against the quota: the primary history, the search and the history of the other listing
    expect(calls(fake, '/eod/')).toBe(2);
    expect(calls(fake, '/search/')).toBe(1);
    expect(stored(h.store, 'TICKER#FWRA.MI', 'PROFILE')).toMatchObject({ enrichedAt: '2026-10-13' });
  });

  it('does not search again for the same ISIN: the stored choice is used (idempotent)', async () => {
    const fake = proxyFake();
    const h = harness({ fake });
    h.store.load([baseline(), { PK: `ISIN#${ISIN}`, SK: 'PROXY', entityType: 'PROXY_LISTING', currency: 'EUR', listing: 'FWRA.AS', checkedOn: '2026-10-01' }]);
    fake.add('eodhd.com/api/eod/FWRA.AS', rows(8, 9));
    await drive(h, createEnrichTransactionsJob(h.deps), event(['FWRA.MI']));
    expect(calls(fake, '/search/')).toBe(0);
    expect(items(h.store, 'TICKER#FWRA.MI', 'EOD#')[0]).toMatchObject({ source: 'eodhd:FWRA.AS' });
  });

  it('searches again when the stored choice was made for another currency', async () => {
    const fake = proxyFake();
    const h = harness({ fake });
    h.store.load([baseline(), { PK: `ISIN#${ISIN}`, SK: 'PROXY', entityType: 'PROXY_LISTING', currency: 'GBP', listing: 'FWRA.L', checkedOn: '2026-10-01' }]);
    await drive(h, createEnrichTransactionsJob(h.deps), event(['FWRA.MI']));
    expect(calls(fake, '/search/')).toBe(1);
    expect(stored(h.store, `ISIN#${ISIN}`, 'PROXY')).toMatchObject({ currency: 'EUR', listing: 'FWRA.DE' });
  });

  it('never overwrites a row the symbol has of its own (a provider close or the broker quote), and replaces an older proxy row', async () => {
    const fake = proxyFake();
    const h = harness({ fake });
    const own = (date: string, extra: Record<string, unknown>): Item => ({ PK: 'TICKER#FWRA.MI', SK: `EOD#${date}`, entityType: 'EOD', symbol: 'FWRA.MI', date, close: 7, currency: 'EUR', ...extra });
    h.store.load([baseline(), own('2026-10-09', {}), own('2026-10-10', { source: 't212' }), own('2026-10-11', { source: 'eodhd:FWRA.AS' })]);
    await drive(h, createEnrichTransactionsJob(h.deps), event(['FWRA.MI']));
    expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-09')).toMatchObject({ close: 7 });
    expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-09')).not.toHaveProperty('source');
    expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-10')).toMatchObject({ close: 7, source: 't212' });
    expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-11')).toMatchObject({ close: 103, source: 'eodhd:FWRA.DE' });
    expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-08')).toMatchObject({ source: 'eodhd:FWRA.DE' });
  });

  it('lets the symbol’s own provider history replace the proxy rows once the provider knows it', async () => {
    const h = harness({ fake: proxyFake() });
    h.store.load([baseline()]);
    await drive(h, createEnrichTransactionsJob(h.deps), event(['FWRA.MI']));
    expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-12')).toMatchObject({ source: 'eodhd:FWRA.DE' });
    const later = harness({ store: h.store, fake: new FakeFetch().add('eodhd.com/api/eod/FWRA.MI', rows(8, 12).map((r) => ({ ...r, close: r.close + 0.4 }))).add('eodhd.com/api/div/', []).add('eodhd.com/api/real-time/', { code: 'FWRA.MI', close: 104.4, previousClose: 103.4, timestamp: NOW_SECONDS }) });
    h.store.load([baseline()]);
    await drive(later, createEnrichTransactionsJob(later.deps), event(['FWRA.MI']));
    const row = stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-12');
    expect(row).toMatchObject({ close: 104.4 });
    expect(row).not.toHaveProperty('source');
    expect(calls(later.fake, '/search/')).toBe(0);
  });

  it('skips the symbol (as before) without an ISIN, without a usable listing and for a provider that cannot search', async () => {
    const noIsin = harness({ fake: proxyFake() });
    noIsin.store.load([baseline({ isin: undefined })]);
    expect((await drive(noIsin, createEnrichTransactionsJob(noIsin.deps), event(['FWRA.MI']))).result).toMatchObject({ enriched: [], retry: [] });
    expect(calls(noIsin.fake, '/search/')).toBe(0);
    expect(stored(noIsin.store, 'TICKER#FWRA.MI', 'ENRICH#core')).toMatchObject({ outcome: 'skipped', lastError: 'unknown symbol' });

    const noListing = harness({ fake: proxyFake().add(`eodhd.com/api/search/${ISIN}`, [{ Code: 'FWRA', Exchange: 'XETRA', Currency: 'USD', ISIN }]) });
    noListing.store.load([baseline()]);
    expect((await drive(noListing, createEnrichTransactionsJob(noListing.deps), event(['FWRA.MI']))).result).toMatchObject({ enriched: [] });
    expect(stored(noListing.store, `ISIN#${ISIN}`, 'PROXY')).toMatchObject({ currency: 'EUR', checkedOn: '2026-10-13' });
    expect(stored(noListing.store, `ISIN#${ISIN}`, 'PROXY')).not.toHaveProperty('listing');
    expect(items(noListing.store, 'TICKER#FWRA.MI', 'EOD#')).toEqual([]);

    const bare = harness({ fake: proxyFake(), marketData: (deps, fetch) => ({ ...noListingMarketData(deps, fetch) }) });
    bare.store.load([baseline()]);
    expect((await drive(bare, createEnrichTransactionsJob(bare.deps), event(['FWRA.MI']))).result).toMatchObject({ enriched: [] });
  });

  it('does not repeat a search that found nothing before the retry period is over', async () => {
    const fake = proxyFake().add(`eodhd.com/api/search/${ISIN}`, []);
    const h = harness({ fake });
    h.store.load([baseline(), { PK: `ISIN#${ISIN}`, SK: 'PROXY', entityType: 'PROXY_LISTING', currency: 'EUR', checkedOn: '2026-10-12' }]);
    await drive(h, createEnrichTransactionsJob(h.deps), event(['FWRA.MI']));
    expect(calls(fake, '/search/')).toBe(0);
    expect(PROXY_RETRY_DAYS).toBe(7);
    const old = harness({ fake });
    old.store.load([baseline(), { PK: `ISIN#${ISIN}`, SK: 'PROXY', entityType: 'PROXY_LISTING', currency: 'EUR', checkedOn: '2026-10-06' }]);
    await drive(old, createEnrichTransactionsJob(old.deps), event(['FWRA.MI']));
    expect(calls(fake, '/search/')).toBe(1);
  });

  it('keeps the symbol pending when the search hits the daily limit of the provider', async () => {
    const fake = proxyFake().add(`eodhd.com/api/search/${ISIN}`, { status: 402 });
    const h = harness({ fake });
    h.store.load([baseline()]);
    const step = await createEnrichTransactionsJob(h.deps)({ payload: event(['FWRA.MI']) });
    expect(step.done).toBe(false);
    expect(items(h.store, 'TICKER#FWRA.MI', 'EOD#')).toEqual([]);
    expect(stored(h.store, `ISIN#${ISIN}`, 'PROXY')).toBeUndefined();
  });

  it('does not look for a proxy for a US symbol', async () => {
    const fake = new FakeFetch().add('twelvedata.com/time_series', { code: 404, status: 'error' });
    const h = harness({ fake });
    h.store.load([{ ...baseline(), PK: 'TICKER#AAPL', symbol: 'AAPL' }]);
    await drive(h, createEnrichTransactionsJob(h.deps), event(['AAPL']));
    expect(calls(fake, '/search/')).toBe(0);
  });
});

/** A market-data provider that has no history for anything and cannot search by ISIN. */
function noListingMarketData(_deps: unknown, _fetch: unknown) {
  const provider = {
    name: 'plain',
    getQuotes: () => Promise.resolve({ quotes: {}, failed: [], unavailable: [] }),
    getEodHistory: () => Promise.reject(Object.assign(new Error('none'), { name: 'SymbolNotFoundError' })),
    getProfile: () => Promise.resolve(null),
    getDividends: () => Promise.resolve([]),
  };
  return { provider, fx: {} as never };
}
