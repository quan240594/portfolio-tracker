import { MemoryItemStore } from '@portfolio/platform';
import { describe, expect, it } from 'vitest';
import { PriceRepository, budgetKey, stateKey } from './repository.js';

const profile = (symbol: string, extra: Record<string, unknown> = {}) => ({ PK: `TICKER#${symbol}`, SK: 'PROFILE', entityType: 'PROFILE', symbol, name: symbol, assetClass: 'STOCK', currency: 'USD', ...extra });

describe('PriceRepository', () => {
  it('lists tracked symbols from the attribute or the sort key, sorted and unique', async () => {
    const store = new MemoryItemStore().load([
      { PK: 'TRACKED', SK: 'TICKER#MSFT', symbol: 'MSFT' },
      { PK: 'TRACKED', SK: 'TICKER#AAPL' },
      { PK: 'TRACKED', SK: 'TICKER#DUP', symbol: 'AAPL' },
      { PK: 'TRACKED', SK: 'TICKER#BLANK', symbol: '' },
      { PK: 'TRACKED', SK: 'OTHER#X' },
    ]);
    expect(await new PriceRepository(store).listTracked()).toEqual(['AAPL', 'BLANK', 'MSFT']);
    expect(await new PriceRepository(new MemoryItemStore()).listTracked()).toEqual([]);
  });

  it('reads the names of the stored profiles and leaves out symbols without a profile or a name', async () => {
    const store = new MemoryItemStore().load([profile('AAA', { name: 'Alpha Corp' }), profile('BBB', { name: '  ' }), profile('CCC', { name: undefined })]);
    const repo = new PriceRepository(store);
    expect(await repo.profileNames(['AAA', 'BBB', 'CCC', 'NONE'])).toEqual(new Map([['AAA', 'Alpha Corp']]));
    expect(await repo.profileNames([])).toEqual(new Map());
  });

  it('finds the symbols that have a profile and the stale details, never-fetched first', async () => {
    const store = new MemoryItemStore().load([profile('AAA'), profile('BBB', { detailsAsOf: '2026-09-01' }), profile('CCC', { detailsAsOf: '2026-10-10' })]);
    const repo = new PriceRepository(store);
    expect(await repo.symbolsWithProfile(['AAA', 'CCC', 'NONE'])).toEqual(new Set(['AAA', 'CCC']));
    expect(await repo.symbolsWithProfile([])).toEqual(new Set());
    expect(await repo.staleProfileDetails([], '2026-09-13')).toEqual([]);
    expect(await repo.staleProfileDetails(['AAA', 'BBB', 'CCC', 'NOPROFILE'], '2026-08-01')).toEqual(['AAA']);
    expect(await repo.staleProfileDetails(['AAA', 'BBB', 'CCC'], '2026-10-01')).toEqual(['AAA', 'BBB']);
    expect(await repo.staleProfileDetails(['AAA', 'BBB', 'CCC'], '2026-10-20')).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('updates only the details of an existing profile', async () => {
    const store = new MemoryItemStore().load([profile('AAA', { sector: 'Energy' })]);
    const repo = new PriceRepository(store);
    await repo.putProfileDetails('AAA', { symbol: 'AAA', name: 'Changed', assetClass: 'ETF', currency: 'EUR', description: 'Hello', beta: 1.1 }, '2026-10-13');
    expect(await store.get({ PK: 'TICKER#AAA', SK: 'PROFILE' })).toMatchObject({ name: 'AAA', sector: 'Energy', assetClass: 'STOCK', description: 'Hello', beta: 1.1, detailsAsOf: '2026-10-13' });
    await repo.putProfileDetails('AAA', null, '2026-10-14');
    expect(await store.get({ PK: 'TICKER#AAA', SK: 'PROFILE' })).toMatchObject({ description: 'Hello', detailsAsOf: '2026-10-14' });
    await expect(repo.putProfileDetails('MISSING', null, '2026-10-13')).rejects.toThrow('No PROFILE item for MISSING');
  });

  it('writes quotes with their EOD row, de-duplicates batches and finds the newest FX day', async () => {
    const store = new MemoryItemStore();
    const repo = new PriceRepository(store);
    await repo.putQuotes([{ symbol: 'AAPL', price: 2, previousClose: 1, currency: 'USD', asOf: '2026-10-13T16:30:00.000Z', source: 's' }]);
    expect((await store.get({ PK: 'TICKER#AAPL', SK: 'EOD#2026-10-13' }))!.close).toBe(2);
    expect(await repo.putEods([{ symbol: 'X', date: '2026-01-02', close: 1, currency: 'USD' }, { symbol: 'X', date: '2026-01-02', close: 2, currency: 'USD' }])).toBe(1);
    expect((await store.get({ PK: 'TICKER#X', SK: 'EOD#2026-01-02' }))!.close).toBe(2);
    expect(await repo.putDividends([{ symbol: 'X', exDate: '2026-02-01', amount: 1, currency: 'USD' }])).toBe(1);

    expect(await repo.latestFxDay('EUR')).toBeNull();
    await repo.putFx({ base: 'EUR', rates: { USD: 1.1 }, asOf: 't' });
    const days = ['2026-10-09', '2026-10-12', '2026-10-08'].map((date) => ({ base: 'EUR', date, rates: { USD: 1.1, EUR: 1 } }));
    expect(await repo.putFxDays(days)).toBe(3);
    expect(await repo.putFxDays([{ base: 'USD', date: '2026-10-13', rates: { EUR: 0.9 } }])).toBe(1);
    expect(await repo.latestFxDay('EUR')).toBe('2026-10-12');
    expect(await repo.latestFxDay('USD')).toBe('2026-10-13');
    expect(await repo.latestFxDay('GBP')).toBeNull();
    expect(await store.get({ PK: 'FX#EUR', SK: 'DAY#2026-10-09' })).toEqual({ PK: 'FX#EUR', SK: 'DAY#2026-10-09', entityType: 'FX_DAY', base: 'EUR', date: '2026-10-09', rates: { USD: 1.1 } });
  });

  it('keeps the listing chosen for an ISIN, and the fact that there was none', async () => {
    const store = new MemoryItemStore();
    const repo = new PriceRepository(store);
    expect(await repo.getProxyListing('IE000000FWRA')).toBeUndefined();
    await repo.putProxyListing({ isin: 'IE000000FWRA', currency: 'EUR', listing: 'FWRA.DE', checkedOn: '2026-10-13' });
    expect(await repo.getProxyListing('IE000000FWRA')).toEqual({ isin: 'IE000000FWRA', currency: 'EUR', listing: 'FWRA.DE', checkedOn: '2026-10-13' });
    await repo.putProxyListing({ isin: 'IE000000FWRA', currency: 'EUR', listing: null, checkedOn: '2026-10-14' });
    expect(await repo.getProxyListing('IE000000FWRA')).toEqual({ isin: 'IE000000FWRA', currency: 'EUR', listing: null, checkedOn: '2026-10-14' });
    expect(await store.get({ PK: 'ISIN#IE000000FWRA', SK: 'PROXY' })).not.toHaveProperty('listing');
    store.load([{ PK: 'ISIN#BROKEN', SK: 'PROXY', entityType: 'PROXY_LISTING', currency: 5 }]);
    expect(await repo.getProxyListing('BROKEN')).toBeUndefined();
  });

  it('reads the latest quotes and skips corrupt items', async () => {
    const store = new MemoryItemStore().load([
      { PK: 'TICKER#A', SK: 'QUOTE#LATEST', symbol: 'A', price: 1, previousClose: 1, currency: 'USD', asOf: 't', source: 's' },
      { PK: 'TICKER#B', SK: 'QUOTE#LATEST', symbol: 'B', price: 'x', previousClose: 1, currency: 'USD', asOf: 't' },
      { PK: 'TICKER#C', SK: 'QUOTE#LATEST', symbol: 'C', price: 1, previousClose: 1, currency: 'USD', asOf: 't' },
    ]);
    const quotes = await new PriceRepository(store).latestQuotes(['A', 'B', 'C', 'D']);
    expect([...quotes.keys()]).toEqual(['A', 'C']);
    expect(quotes.get('C')!.source).toBe('');
    expect((await new PriceRepository(store).latestQuotes([])).size).toBe(0);
  });

  it('creates the tracked item only once', async () => {
    const repo = new PriceRepository(new MemoryItemStore());
    expect(await repo.ensureTracked('AAPL', 'now')).toBe(true);
    expect(await repo.ensureTracked('AAPL', 'later')).toBe(false);
    expect(await repo.putQuote({ symbol: 'AAPL', price: 1, previousClose: 1, currency: 'USD', asOf: 't', source: 's' })).toBe(true);
    expect(await repo.putProfile({ symbol: 'AAPL', name: 'A', assetClass: 'STOCK', currency: 'USD' })).toBe(true);
  });

  it('keeps the calendar items: earnings, splits, stale report dates, markers and budgets', async () => {
    const store = new MemoryItemStore();
    const repo = new PriceRepository(store);
    expect(await repo.putEarnings([{ symbol: 'AAPL', date: '2026-07-30', source: 's' }, { symbol: 'AAPL', date: '2026-10-29', source: 's' }, { symbol: 'AAPL', date: '2026-11-05', source: 's' }], 'u')).toBe(3);
    expect(await repo.putSplits([{ symbol: 'AAPL', date: '2026-11-02', fromFactor: 1, toFactor: 4, source: 's' }], 'u')).toBe(1);
    expect(await repo.staleEarningsDates('AAPL', '2026-10-15', new Set(['2026-11-05']))).toEqual(['2026-10-29']);
    expect(await repo.deleteEarnings('AAPL', ['2026-10-29'])).toBe(1);
    expect(await store.get({ PK: 'TICKER#AAPL', SK: 'EARN#2026-10-29' })).toBeUndefined();

    expect(await repo.getStates([])).toEqual(new Map());
    await repo.putState('AAPL', { splitsCheckedAt: 'a' });
    await repo.putState('AAPL', { dividendsCheckedAt: 'b', splitsFailedAt: 'c' });
    expect(await repo.getStates(['AAPL', 'KO'])).toEqual(new Map([['AAPL', { splitsCheckedAt: 'a', dividendsCheckedAt: 'b', splitsFailedAt: 'c' }]]));
    expect(await store.get(stateKey('AAPL'))).toMatchObject({ entityType: 'CALENDAR_STATE', symbol: 'AAPL' });

    expect(await repo.consumeBudget('eodhd', '2026-10-15', 2, 3)).toBe(true);
    expect(await repo.consumeBudget('eodhd', '2026-10-15', 2, 3)).toBe(false);
    expect(await store.get(budgetKey('eodhd'))).toEqual({ PK: 'CALENDAR', SK: 'BUDGET#eodhd', entityType: 'CALENDAR_BUDGET', day: '2026-10-15', used: 2 });
  });

  describe('profile sources', () => {
    const provider = { symbol: 'AAA', name: 'Aaa Inc', assetClass: 'STOCK' as const, currency: 'USD', sector: 'Technology', country: 'United States', description: 'Makes things.' };

    it('treats a profile as enriched when it has no source (legacy) or the job stamped it', async () => {
      const store = new MemoryItemStore().load([
        profile('LEGACY'),
        profile('BASELINE', { profileSource: 'trading212' }),
        profile('STAMPED', { profileSource: 'trading212', enrichedAt: '2026-10-13' }),
        profile('MINIMAL', { profileSource: 'minimal' }),
      ]);
      const repo = new PriceRepository(store);
      expect(await repo.enrichedSymbols(['LEGACY', 'BASELINE', 'STAMPED', 'MINIMAL', 'NONE'])).toEqual(new Set(['LEGACY', 'STAMPED']));
      expect(await repo.enrichedSymbols([])).toEqual(new Set());
      expect(await repo.getProfile('BASELINE')).toMatchObject({ symbol: 'BASELINE', profileSource: 'trading212' });
      expect(await repo.getProfile('NONE')).toBeUndefined();
    });

    it('lists the stale profiles with their source', async () => {
      const store = new MemoryItemStore().load([profile('AAA'), profile('BBB', { profileSource: 'trading212' }), profile('CCC', { profileSource: 'nonsense', detailsAsOf: '2026-10-12' })]);
      const repo = new PriceRepository(store);
      expect(await repo.staleProfiles(['AAA', 'BBB', 'CCC'], '2026-10-13')).toEqual([
        { symbol: 'AAA', source: 'provider' },
        { symbol: 'BBB', source: 'trading212' },
        { symbol: 'CCC', source: 'provider' },
      ]);
      expect(await repo.staleProfiles([], '2026-10-13')).toEqual([]);
    });

    it('merges a provider profile over a baseline or minimal profile and only updates details on a provider profile', async () => {
      const store = new MemoryItemStore().load([profile('AAA', { name: 'AAA', assetClass: 'OTHER', isin: 'US0000000002', country: 'Ireland', profileSource: 'trading212' })]);
      const repo = new PriceRepository(store);
      await repo.putProfileDetails('AAA', provider, '2026-10-13');
      expect(await store.get({ PK: 'TICKER#AAA', SK: 'PROFILE' })).toMatchObject({ name: 'Aaa Inc', assetClass: 'STOCK', sector: 'Technology', country: 'United States', isin: 'US0000000002', description: 'Makes things.', profileSource: 'provider', detailsAsOf: '2026-10-13' });
      // Now a provider profile: only the details move.
      await repo.putProfileDetails('AAA', { ...provider, name: 'Renamed', sector: 'Energy', beta: 1.1 }, '2026-10-14');
      expect(await store.get({ PK: 'TICKER#AAA', SK: 'PROFILE' })).toMatchObject({ name: 'Aaa Inc', sector: 'Technology', beta: 1.1, detailsAsOf: '2026-10-14' });
      // Nothing found on a baseline: only the date.
      const baselineStore = new MemoryItemStore().load([profile('BBB', { profileSource: 'trading212' })]);
      await new PriceRepository(baselineStore).putProfileDetails('BBB', null, '2026-10-13');
      expect(await baselineStore.get({ PK: 'TICKER#BBB', SK: 'PROFILE' })).toMatchObject({ profileSource: 'trading212', detailsAsOf: '2026-10-13' });
    });

    it('keeps the Trading 212 ticker through every provider write', async () => {
      const store = new MemoryItemStore().load([profile('KMB', { name: 'Kimberly', profileSource: 'trading212', t212Ticker: 'KMB_US_EQ' })]);
      const repo = new PriceRepository(store);
      await repo.putProfileDetails('KMB', { ...provider, symbol: 'KMB' }, '2026-10-13');
      expect(await store.get({ PK: 'TICKER#KMB', SK: 'PROFILE' })).toMatchObject({ profileSource: 'provider', t212Ticker: 'KMB_US_EQ' });
      await repo.putProfileDetails('KMB', { ...provider, symbol: 'KMB', name: 'Again' }, '2026-10-14');
      expect(await store.get({ PK: 'TICKER#KMB', SK: 'PROFILE' })).toMatchObject({ t212Ticker: 'KMB_US_EQ' });
      const other = new MemoryItemStore().load([profile('VICI', { name: 'Vici', profileSource: 'trading212', t212Ticker: 'VICI_US_EQ' })]);
      await new PriceRepository(other).putEnrichedProfile('VICI', { ...provider, symbol: 'VICI' }, { symbol: 'VICI', name: 'VICI', assetClass: 'OTHER', currency: 'USD' }, '2026-10-13');
      expect(await other.get({ PK: 'TICKER#VICI', SK: 'PROFILE' })).toMatchObject({ profileSource: 'provider', t212Ticker: 'VICI_US_EQ' });
    });

    it('stamps the enrichment: provider over baseline, the baseline kept when no provider answered, the minimal profile as the floor', async () => {
      const store = new MemoryItemStore().load([profile('BASE', { name: 'Base Co', profileSource: 'trading212', isin: 'US0000000002' })]);
      const repo = new PriceRepository(store);
      const minimal = (symbol: string) => ({ symbol, name: symbol, assetClass: 'OTHER' as const, currency: 'USD' });
      await repo.putEnrichedProfile('BASE', null, minimal('BASE'), '2026-10-13');
      expect(await store.get({ PK: 'TICKER#BASE', SK: 'PROFILE' })).toMatchObject({ name: 'Base Co', assetClass: 'STOCK', profileSource: 'trading212', isin: 'US0000000002', enrichedAt: '2026-10-13' });
      await repo.putEnrichedProfile('BASE', { ...provider, symbol: 'BASE' }, minimal('BASE'), '2026-10-14');
      expect(await store.get({ PK: 'TICKER#BASE', SK: 'PROFILE' })).toMatchObject({ name: 'Aaa Inc', sector: 'Technology', isin: 'US0000000002', profileSource: 'provider', enrichedAt: '2026-10-14', detailsAsOf: '2026-10-14' });
      await repo.putEnrichedProfile('NEW', null, minimal('NEW'), '2026-10-13');
      expect(await store.get({ PK: 'TICKER#NEW', SK: 'PROFILE' })).toMatchObject({ name: 'NEW', profileSource: 'minimal', enrichedAt: '2026-10-13' });
    });
  });

  describe('attempts and blocks', () => {
    it('counts the tries of today only', async () => {
      const store = new MemoryItemStore();
      const repo = new PriceRepository(store);
      await repo.putAttempts('core', 'AAA', '2026-10-13', 2, 'retry', 'x'.repeat(500));
      await repo.putAttempts('core', 'BBB', '2026-10-12', 3, 'retry', 'old');
      await repo.putAttempts('profile', 'AAA', '2026-10-13', 1, 'skipped', 'profile');
      expect(await repo.attemptsOn('core', ['AAA', 'BBB', 'CCC'], '2026-10-13')).toEqual(new Map([['AAA', { count: 2, skipped: false }]]));
      expect(await repo.attemptsOn('profile', ['AAA'], '2026-10-13')).toEqual(new Map([['AAA', { count: 1, skipped: true }]]));
      expect(await repo.attemptsOn('core', [], '2026-10-13')).toEqual(new Map());
      expect(((await store.get({ PK: 'TICKER#AAA', SK: 'ENRICH#core' }))!.lastError as string).length).toBe(200);
    });

    it('reads the blocks in force', async () => {
      const store = new MemoryItemStore().load([{ PK: 'USAGE', SK: 'BLOCK#eodhd', until: Date.parse('2026-10-14T00:01:00Z'), scope: 'day' }]);
      const repo = new PriceRepository(store);
      expect((await repo.blockedProviders(['eodhd', 'twelvedata'], new Date('2026-10-13T16:30:00Z'))).get('eodhd')).toEqual({ until: Date.parse('2026-10-14T00:01:00Z'), scope: 'day' });
      expect(await repo.blockedProviders(['eodhd'], new Date('2026-10-14T00:02:00Z'))).toEqual(new Map());
    });

    it('reads the last recorded try of a symbol whatever its day, and ignores other items', async () => {
      const store = new MemoryItemStore().load([{ PK: 'TICKER#NOPE', SK: 'ENRICH#core', entityType: 'ENRICH_STATE', symbol: 'NOPE' }]);
      const repo = new PriceRepository(store);
      await repo.putAttempts('core', 'AAA', '2026-10-12', 3, 'skipped', 'unknown symbol');
      await repo.putAttempts('core', 'BBB', '2026-10-13', 1, 'retry', 'timeout');
      await repo.putAttempts('profile', 'CCC', '2026-10-13', 1, 'retry', 'profile only');
      expect(await repo.lastAttempts(['AAA', 'BBB', 'CCC', 'NOPE', 'NONE'])).toEqual(
        new Map([
          ['AAA', { day: '2026-10-12', attempts: 3, outcome: 'skipped', error: 'unknown symbol' }],
          ['BBB', { day: '2026-10-13', attempts: 1, outcome: 'retry', error: 'timeout' }],
        ]),
      );
      expect(await repo.lastAttempts([])).toEqual(new Map());
    });

    it('reads the newest EOD rows of one symbol in one query, with their sources', async () => {
      const row = (symbol: string, date: string, extra: Record<string, unknown> = {}) => ({ PK: `TICKER#${symbol}`, SK: `EOD#${date}`, entityType: 'EOD', symbol, date, close: 1, currency: 'USD', ...extra });
      const store = new MemoryItemStore().load([row('AAA', '2026-10-01'), row('AAA', '2026-10-02', { source: 't212' }), row('AAA', '2026-10-03'), row('BBB', '2026-10-09'), { PK: 'TICKER#AAA', SK: 'PROFILE' }]);
      const repo = new PriceRepository(store);
      expect(await repo.newestEod('AAA', 2)).toEqual([{ date: '2026-10-03' }, { date: '2026-10-02', source: 't212' }]);
      expect(await repo.newestEod('AAA', 10)).toHaveLength(3);
      expect(await repo.newestEod('NONE', 10)).toEqual([]);
    });

    it('marks the EOD rows that the owner’s history symbol served', async () => {
      const row = (date: string, extra: Record<string, unknown> = {}) => ({ PK: 'TICKER#AAA', SK: `EOD#${date}`, entityType: 'EOD', symbol: 'AAA', date, close: 1, currency: 'EUR', ...extra });
      const repo = new PriceRepository(new MemoryItemStore().load([row('2026-10-01', { source: 'eodhd:AAA.DE', override: true }), row('2026-10-02', { source: 'eodhd:AAA.DE', override: false }), row('2026-10-03')]));
      expect(await repo.newestEod('AAA', 10)).toEqual([{ date: '2026-10-03' }, { date: '2026-10-02', source: 'eodhd:AAA.DE' }, { date: '2026-10-01', source: 'eodhd:AAA.DE', override: true }]);
    });
  });

  describe('history symbol of the owner', () => {
    const record = { symbol: 'FWRA.MI', historySymbol: 'FWRA.DE', status: 'pending' as const, reason: null, setAt: '2026-10-13T10:00:00.000Z' };

    it('stores, reads and forgets it per held symbol', async () => {
      const repo = new PriceRepository(new MemoryItemStore());
      await repo.putHistorySymbol(record);
      await repo.putHistorySymbol({ symbol: 'AAA', historySymbol: 'AAA.AS', status: 'refused', reason: 'history symbol is quoted in USD, the holding in EUR', setAt: '2026-10-13T11:00:00.000Z' });
      expect(await repo.getHistorySymbol('FWRA.MI')).toEqual(record);
      expect((await repo.getHistorySymbol('AAA'))?.reason).toBe('history symbol is quoted in USD, the holding in EUR');
      expect([...(await repo.getHistorySymbols(['AAA', 'FWRA.MI', 'FWRA.MI', 'NONE'])).keys()].toSorted((a, b) => a.localeCompare(b))).toEqual(['AAA', 'FWRA.MI']);
      expect(await repo.getHistorySymbols([])).toEqual(new Map());
      await repo.clearHistorySymbol('FWRA.MI');
      expect(await repo.getHistorySymbol('FWRA.MI')).toBeUndefined();
      expect(await repo.getHistorySymbol('AAA')).toBeDefined();
    });

    it('ignores an item that is not a history symbol record', async () => {
      const store = new MemoryItemStore().load([
        { PK: 'TICKER#A', SK: 'HISTSYM', historySymbol: 'A.DE', status: 'unknown', setAt: 'x' },
        { PK: 'TICKER#B', SK: 'HISTSYM', status: 'pending', setAt: 'x' },
        { PK: 'TICKER#C', SK: 'HISTSYM', historySymbol: 'C.DE', status: 'pending' },
      ]);
      expect(await new PriceRepository(store).getHistorySymbols(['A', 'B', 'C'])).toEqual(new Map());
    });
  });
});
