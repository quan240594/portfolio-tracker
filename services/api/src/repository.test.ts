import { describe, expect, it, vi } from 'vitest';
import { MemoryItemStore } from '@portfolio/platform';
import type { ImportStatus, Portfolio, Transaction } from '@portfolio/shared';
import { ItemRepository } from './repository.js';

const setup = () => {
  const items = new MemoryItemStore();
  return { items, repo: new ItemRepository(items) };
};

const txn = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id,
  userId: 'u',
  portfolioId: 'p1',
  date: '2025-01-01',
  type: 'BUY',
  symbol: 'A',
  quantity: 1,
  price: 1,
  fee: 0,
  currency: 'EUR',
  createdAt: 'x',
  ...over,
});
const portfolio = (portfolioId: string, over: Partial<Portfolio> = {}): Portfolio => ({ portfolioId, userId: 'u', name: portfolioId, createdAt: 'c', updatedAt: 'c', ...over });

describe('ItemRepository portfolios', () => {
  it('creates a portfolio only once, under the user partition', async () => {
    const { items, repo } = setup();
    expect(await repo.createPortfolio(portfolio('p1'))).toBe(true);
    expect(await repo.createPortfolio(portfolio('p1', { name: 'Other' }))).toBe(false);
    expect(items.snapshot()).toEqual([{ PK: 'USER#u', SK: 'PORTFOLIO#p1', entityType: 'PORTFOLIO', ...portfolio('p1') }]);
  });

  it('reads and lists portfolios consistently, without key attributes', async () => {
    const { items, repo } = setup();
    const get = vi.spyOn(items, 'get');
    await repo.createPortfolio(portfolio('p1'));
    await repo.createPortfolio(portfolio('p2'));
    await repo.createPortfolio(portfolio('p3', { userId: 'other' }));
    expect(await repo.getPortfolio('u', 'p1')).toEqual(portfolio('p1'));
    expect(await repo.getPortfolio('u', 'nope')).toBeNull();
    expect((await repo.listPortfolios('u')).map((p) => p.portfolioId)).toEqual(['p1', 'p2']);
    expect(get).toHaveBeenCalledWith({ PK: 'USER#u', SK: 'PORTFOLIO#p1' }, { consistent: true });
  });

  it('renames an existing portfolio and reports null for a missing one', async () => {
    const { repo } = setup();
    await repo.createPortfolio(portfolio('p1'));
    expect(await repo.renamePortfolio('u', 'p1', 'New', 'later')).toEqual(portfolio('p1', { name: 'New', updatedAt: 'later' }));
    expect(await repo.renamePortfolio('u', 'gone', 'New', 'later')).toBeNull();
    expect(await repo.getPortfolio('u', 'gone')).toBeNull();
  });

  it('deletes a portfolio', async () => {
    const { repo } = setup();
    await repo.createPortfolio(portfolio('p1'));
    await repo.deletePortfolio('u', 'p1');
    expect(await repo.getPortfolio('u', 'p1')).toBeNull();
  });
});

describe('ItemRepository transactions', () => {
  it('stores a transaction under the single-table keys, with a broker fxRate, and lists it back', async () => {
    const { items, repo } = setup();
    await repo.putTransaction(txn('i', { currency: 'USD', fxRate: 1.0842 }));
    expect(items.snapshot()).toEqual([{ PK: 'USER#u', SK: 'TXN#p1#2025-01-01#i', entityType: 'TRANSACTION', ...txn('i', { currency: 'USD', fxRate: 1.0842 }) }]);
    expect(await repo.listTransactions('u')).toEqual([txn('i', { currency: 'USD', fxRate: 1.0842 })]);
  });

  it('refuses to overwrite an existing transaction', async () => {
    const { repo } = setup();
    await repo.putTransaction(txn('i'));
    await expect(repo.putTransaction(txn('i', { quantity: 5 }))).rejects.toThrow('Transaction i already exists');
    expect((await repo.listTransactions('u'))[0]!.quantity).toBe(1);
  });

  it('lists every portfolio by default and one portfolio by its prefix, per user', async () => {
    const { repo } = setup();
    await repo.putTransaction(txn('a'));
    await repo.putTransaction(txn('b', { portfolioId: 'p2' }));
    await repo.putTransaction(txn('c', { portfolioId: 'p10' }));
    await repo.putTransaction(txn('d', { userId: 'other' }));
    expect((await repo.listTransactions('u')).map((t) => t.id)).toEqual(['a', 'c', 'b']);
    expect((await repo.listTransactions('u', 'p1')).map((t) => t.id)).toEqual(['a']);
    expect((await repo.listTransactions('u', 'p2')).map((t) => t.id)).toEqual(['b']);
  });

  it('follows the pages of a long list', async () => {
    const { items, repo } = setup();
    await items.batchWrite(Array.from({ length: 30 }, (_, i) => ({ type: 'put' as const, item: { PK: 'USER#u', SK: `TXN#p1#2025-01-01#t${String(i).padStart(2, '0')}`, ...txn(`t${i}`) } })));
    const query = vi.spyOn(items, 'query');
    expect(await repo.listTransactions('u')).toHaveLength(30);
    expect(query).toHaveBeenCalled();
  });

  it('finds a transaction by id across portfolios, or null', async () => {
    const { repo } = setup();
    await repo.putTransaction(txn('a'));
    await repo.putTransaction(txn('b', { portfolioId: 'p2' }));
    expect(await repo.findTransaction('u', 'b')).toEqual(txn('b', { portfolioId: 'p2' }));
    expect(await repo.findTransaction('u', 'missing')).toBeNull();
    expect(await repo.findTransaction('other', 'a')).toBeNull();
  });

  it('deletes one transaction by key, or many in a batch', async () => {
    const { items, repo } = setup();
    const all = Array.from({ length: 60 }, (_, i) => txn(`t${i}`, { date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}` }));
    for (const t of all) await repo.putTransaction(t);
    await repo.deleteTransaction(all[0]!);
    expect(items.size).toBe(59);
    await repo.deleteTransactions(all.slice(1, 50));
    expect(items.size).toBe(10);
    await repo.deleteTransactions([]);
    expect(items.size).toBe(10);
  });
});

describe('ItemRepository market data', () => {
  it('reads quotes and profiles by symbol, however many are asked for', async () => {
    const { items, repo } = setup();
    expect(await repo.getQuotes([])).toEqual({});
    await items.batchWrite([
      { type: 'put', item: { PK: 'TICKER#A', SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol: 'A', price: 1 } },
      { type: 'put', item: { PK: 'TICKER#B', SK: 'PROFILE', entityType: 'PROFILE', symbol: 'B', name: 'Beta' } },
    ]);
    expect(await repo.getQuotes(['A', 'B', 'C'])).toEqual({ A: { symbol: 'A', price: 1 } });
    expect(await repo.getProfiles(['A', 'B'])).toEqual({ B: { symbol: 'B', name: 'Beta' } });
    const many = Array.from({ length: 250 }, (_, i) => `S${i}`);
    expect(await repo.getQuotes(many)).toEqual({});
  });

  it('getFx returns the rates without keys, or null when absent', async () => {
    const { items, repo } = setup();
    await items.put({ PK: 'FX#EUR', SK: 'LATEST', entityType: 'FX', base: 'EUR', rates: { USD: 1.1 }, asOf: 't' });
    expect(await repo.getFx('EUR')).toEqual({ base: 'EUR', rates: { USD: 1.1 }, asOf: 't' });
    expect(await repo.getFx('GBP')).toBeNull();
  });

  it('getFxHistory returns the fixings between the bounds, oldest first, deriving base/date/rates when missing', async () => {
    const { items, repo } = setup();
    await items.batchWrite([
      { type: 'put', item: { PK: 'FX#EUR', SK: 'DAY#2025-01-06', entityType: 'FX_DAY', base: 'EUR', date: '2025-01-06', rates: { USD: 1.04 }, source: 'ECB' } },
      { type: 'put', item: { PK: 'FX#EUR', SK: 'DAY#2025-01-02', entityType: 'FX_DAY' } },
      { type: 'put', item: { PK: 'FX#EUR', SK: 'DAY#2024-12-01', entityType: 'FX_DAY', rates: {} } },
      { type: 'put', item: { PK: 'FX#EUR', SK: 'LATEST', entityType: 'FX' } },
    ]);
    expect(await repo.getFxHistory('EUR', '2025-01-01', '2025-01-31')).toEqual([
      { base: 'EUR', date: '2025-01-02', rates: {} },
      { base: 'EUR', date: '2025-01-06', rates: { USD: 1.04 } },
    ]);
    expect(await repo.getFxHistory('GBP', '2025-01-01', '2025-01-31')).toEqual([]);
  });

  it('getEod and getDividendEvents query the ticker partition without keys', async () => {
    const { items, repo } = setup();
    await items.batchWrite([
      { type: 'put', item: { PK: 'TICKER#A', SK: 'EOD#2025-01-02', entityType: 'EOD', symbol: 'A', date: '2025-01-02', close: 3 } },
      { type: 'put', item: { PK: 'TICKER#A', SK: 'EOD#2025-03-02', entityType: 'EOD', symbol: 'A', date: '2025-03-02', close: 4 } },
      { type: 'put', item: { PK: 'TICKER#A', SK: 'DIV#2025-02-01', entityType: 'DIVIDEND_EVENT', symbol: 'A', exDate: '2025-02-01', amount: 0.25, currency: 'USD' } },
    ]);
    expect(await repo.getEod('A', '2025-01-01', '2025-01-31')).toEqual([{ symbol: 'A', date: '2025-01-02', close: 3 }]);
    expect(await repo.getDividendEvents('A')).toEqual([{ symbol: 'A', exDate: '2025-02-01', amount: 0.25, currency: 'USD' }]);
    expect(await repo.getDividendEvents('B')).toEqual([]);
  });

  it('getCalendarEvents reads the EARN# and SPLIT# ranges of every symbol', async () => {
    const { items, repo } = setup();
    await items.batchWrite([
      { type: 'put', item: { PK: 'TICKER#AAPL', SK: 'EARN#2026-07-30', entityType: 'EARNINGS_EVENT', symbol: 'AAPL', date: '2026-07-30', source: 'alphavantage' } },
      { type: 'put', item: { PK: 'TICKER#AAPL', SK: 'EARN#2027-07-30', entityType: 'EARNINGS_EVENT', symbol: 'AAPL', date: '2027-07-30', source: 'alphavantage' } },
      { type: 'put', item: { PK: 'TICKER#MSFT', SK: 'SPLIT#2026-07-01', entityType: 'SPLIT_EVENT', symbol: 'MSFT', date: '2026-07-01', fromFactor: 1, toFactor: 2, source: 'eodhd' } },
      { type: 'put', item: { PK: 'TICKER#OTHER', SK: 'EARN#2026-07-30', entityType: 'EARNINGS_EVENT', symbol: 'OTHER', date: '2026-07-30', source: 's' } },
    ]);
    expect(await repo.getCalendarEvents(['AAPL', 'MSFT'], '2026-06-01', '2026-12-31')).toEqual({
      earnings: [{ symbol: 'AAPL', date: '2026-07-30', source: 'alphavantage' }],
      splits: [{ symbol: 'MSFT', date: '2026-07-01', fromFactor: 1, toFactor: 2, source: 'eodhd' }],
    });
    expect(await repo.getCalendarEvents([], '2026-06-01', '2026-12-31')).toEqual({ earnings: [], splits: [] });
  });

  it('getEarningsDatesData reads the upcoming dates, the tracked-ticker items and the two run records of the calendar job', async () => {
    const { items, repo } = setup();
    const record = { at: '2026-10-28T04:30:00.000Z', trigger: 'scheduled', status: 'ok', reason: '', tracked: 2, rows: 10, events: 1, matchedSymbols: ['AAPL'] };
    await items.batchWrite([
      { type: 'put', item: { PK: 'TICKER#AAPL', SK: 'EARN#2026-10-20', entityType: 'EARNINGS_EVENT', symbol: 'AAPL', date: '2026-10-20', source: 'alphavantage' } },
      { type: 'put', item: { PK: 'TICKER#AAPL', SK: 'EARN#2026-10-29', entityType: 'EARNINGS_EVENT', symbol: 'AAPL', date: '2026-10-29', source: 'alphavantage' } },
      { type: 'put', item: { PK: 'TRACKED', SK: 'TICKER#AAPL', entityType: 'TRACKED_TICKER', symbol: 'AAPL', createdAt: '2026-01-02T10:00:00.000Z' } },
      { type: 'put', item: { PK: 'TRACKED', SK: 'TICKER#MSFT', entityType: 'TRACKED_TICKER', symbol: 'MSFT' } },
      { type: 'put', item: { PK: 'CALENDAR', SK: 'EARNINGS#LASTRUN', entityType: 'EARNINGS_RUN', ...record, status: 'failed', reason: 'boom' } },
      { type: 'put', item: { PK: 'CALENDAR', SK: 'EARNINGS#LASTOK', entityType: 'EARNINGS_RUN', ...record } },
    ]);
    const data = await repo.getEarningsDatesData(['AAPL', 'MSFT', 'GOOGL'], '2026-10-28');
    expect(data.upcoming).toEqual([{ symbol: 'AAPL', date: '2026-10-29', source: 'alphavantage' }]);
    expect(data.tracked).toEqual(
      new Map([
        ['AAPL', '2026-01-02T10:00:00.000Z'],
        ['MSFT', null],
      ]),
    );
    expect(data.run).toMatchObject({ status: 'failed', reason: 'boom' });
    expect(data.lastOk).toMatchObject({ status: 'ok', rows: 10, matchedSymbols: ['AAPL'] });
  });

  it('getEarningsDatesData without symbols or records is empty', async () => {
    const { repo } = setup();
    expect(await repo.getEarningsDatesData([], '2026-10-28')).toEqual({ tracked: new Map(), upcoming: [], run: null, lastOk: null });
  });
});

describe('ItemRepository registry and imports', () => {
  it('registerUser stamps timestamps and preserves createdAt', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-02T03:04:05.000Z'), toFake: ['Date'] });
    try {
      const { items, repo } = setup();
      await repo.registerUser('u');
      vi.setSystemTime(new Date('2026-02-02T00:00:00.000Z'));
      await repo.registerUser('u');
      expect(await items.get({ PK: 'USERS', SK: 'USER#u' })).toEqual({
        PK: 'USERS',
        SK: 'USER#u',
        entityType: 'USER',
        userId: 'u',
        createdAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-02-02T00:00:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('trackTickers upserts one item per market ticker without overwriting an existing currency', async () => {
    const { items, repo } = setup();
    await repo.trackTickers([{ symbol: 'A', currency: 'EUR' }, { symbol: 'B', currency: 'USD' }, { symbol: 'CASH.EUR', currency: 'EUR' }, { symbol: 'NVDA' }]);
    await repo.trackTickers([{ symbol: 'B', currency: 'GBP' }]);
    await repo.trackTickers([]);
    expect(items.snapshot().map((i) => [i.SK, i.currency])).toEqual([
      ['TICKER#A', 'EUR'],
      ['TICKER#B', 'USD'],
      ['TICKER#NVDA', undefined],
    ]);
  });

  const status: ImportStatus = { importId: 'imp', userId: 'u', portfolioId: 'p1', fileName: 'a.csv', status: 'PENDING', createdAt: 't', updatedAt: 't' };

  it('putImport stores the import under the user partition; getImport reads it consistently or returns null', async () => {
    const { items, repo } = setup();
    const get = vi.spyOn(items, 'get');
    await repo.putImport(status);
    expect(items.snapshot()).toEqual([{ PK: 'USER#u', SK: 'IMPORT#imp', entityType: 'IMPORT', ...status }]);
    expect(await repo.getImport('u', 'imp')).toEqual(status);
    expect(await repo.getImport('u', 'nope')).toBeNull();
    expect(get).toHaveBeenCalledWith({ PK: 'USER#u', SK: 'IMPORT#imp' }, { consistent: true });
  });

  it('getConsensus reads the quarters and the state of a symbol from the ticker partition, newest first, ignoring other rows', async () => {
    const { items, repo } = setup();
    const at = '2026-10-12T06:20:00.000Z';
    await items.put({ PK: 'TICKER#A', SK: 'EARNEST#2026-06-30', entityType: 'EARNINGS_CONSENSUS', symbol: 'A', quarterEnd: '2026-06-30', ticker: 'A', fetchedAt: at, eps: { average: 1 } });
    await items.put({ PK: 'TICKER#A', SK: 'EARNEST#2026-09-30', entityType: 'EARNINGS_CONSENSUS', symbol: 'A', quarterEnd: '2026-09-30', ticker: 'A', fetchedAt: at, eps: { average: 2 } });
    await items.put({ PK: 'TICKER#A', SK: 'EARNEST#STATE', entityType: 'EARNINGS_CONSENSUS_STATE', symbol: 'A', outcome: 'ok', at, updatedAt: at });
    await items.put({ PK: 'TICKER#A', SK: 'EARNSUM#2026-10-21', entityType: 'EARNINGS_SUMMARY' });
    await items.put({ PK: 'TICKER#B', SK: 'EARNEST#2026-09-30', entityType: 'EARNINGS_CONSENSUS', symbol: 'B', quarterEnd: '2026-09-30', ticker: 'B', fetchedAt: at });
    const found = await repo.getConsensus('A');
    expect(found.quarters.map((quarter) => quarter.quarterEnd)).toEqual(['2026-09-30', '2026-06-30']);
    expect(found.state).toEqual({ symbol: 'A', outcome: 'ok', at, updatedAt: at });
    expect(await repo.getConsensus('NOPE')).toEqual({ quarters: [], state: null });
  });
});
