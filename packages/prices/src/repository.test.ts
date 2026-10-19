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
});
