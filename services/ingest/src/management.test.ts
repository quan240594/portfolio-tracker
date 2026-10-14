import { describe, expect, it } from 'vitest';
import { buildPositions, cashBalances, transactionsToCsv, type Transaction } from '@portfolio/shared';
import { parseImportCsv } from './csv.js';
import { processImportObject } from './processor.js';
import { fakeIngestDeps } from './testing/fakes.js';

const BUCKET = 'bucket';
const HEADER = 'date,type,symbol,quantity,price,fee,currency';

function setup(csv: string) {
  const ctx = fakeIngestDeps();
  ctx.store.addImport('demo', 'imp1');
  ctx.reader.objects.set(`${BUCKET}/imports/demo/imp1.csv`, csv);
  return { ...ctx, run: () => processImportObject(ctx.deps, { bucket: BUCKET, key: 'imports/demo/imp1.csv' }) };
}

describe('CSV rows of the portfolio-management types', () => {
  it('accepts deposits, withdrawals, fees, interest and splits', () => {
    const csv = [
      HEADER,
      '2025-01-02,DEPOSIT,CASH.EUR,1000,1,0,EUR',
      '2025-01-03,BUY,ASML.AS,2,500,0,EUR',
      '2025-02-03,SPLIT,ASML.AS,2,0,0,EUR',
      '2025-03-01,interest,CASH.EUR,1.5,1,0,EUR',
      '2025-03-02,FEE,CASH.EUR,0.5,1,0,EUR',
      '2025-03-03,WITHDRAWAL,CASH.EUR,100,1,0,EUR',
    ].join('\n');
    const parsed = parseImportCsv(csv);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.rows.map((r) => r.input.type)).toEqual(['DEPOSIT', 'BUY', 'SPLIT', 'INTEREST', 'FEE', 'WITHDRAWAL']);
  });

  it('reports row-level errors for invalid cash and split rows', () => {
    const parsed = parseImportCsv(
      [HEADER, '2025-01-02,DEPOSIT,AAPL,1000,1,0,EUR', '2025-01-02,DEPOSIT,CASH.EUR,1000,0,0,EUR', '2025-01-02,SPLIT,AAPL,2,0,1,EUR', '2025-01-02,BUY,CASH.EUR,1,1,0,EUR'].join('\n'),
    );
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors).toEqual([
      { row: 1, message: 'symbol: Cash movements use the symbol CASH.EUR' },
      { row: 2, message: 'price: Price must be greater than 0 (use 1 and put the amount in quantity)' },
      { row: 3, message: 'fee: Fee is not applicable to SPLIT' },
      { row: 4, message: 'symbol: CASH.* and CUSTOM:* symbols are reserved' },
    ]);
  });
});

describe('import of cash movements and splits', () => {
  it('stores them, tracks and announces only priced symbols', async () => {
    const { run, store, events } = setup(
      [HEADER, '2025-01-02,DEPOSIT,CASH.EUR,5000,1,0,EUR', '2025-01-03,BUY,ASML.AS,2,500,2,EUR', '2025-02-03,SPLIT,ASML.AS,2,0,0,EUR'].join('\n'),
    );
    expect(await run()).toBe('COMPLETED');
    expect(store.transactions.map((t) => [t.type, t.symbol])).toEqual([
      ['DEPOSIT', 'CASH.EUR'],
      ['BUY', 'ASML.AS'],
      ['SPLIT', 'ASML.AS'],
    ]);
    expect([...store.tracked.keys()]).toEqual(['ASML.AS']);
    expect(events.published).toEqual([{ userId: 'demo', portfolioId: 'default', symbols: ['ASML.AS'], reason: 'IMPORTED', importId: 'imp1' }]);
    expect(buildPositions(store.transactions).get('ASML.AS')!.quantity).toBe(4);
    expect(cashBalances(store.transactions, new Set(['default'])).get('EUR')).toBe(3998); // 5000 - (2 x 500 + 2 fee)
  });

  it('publishes no event when the file only moves cash', async () => {
    const { run, store, events } = setup(`${HEADER}\n2025-01-02,DEPOSIT,CASH.EUR,5000,1,0,EUR\n`);
    expect(await run()).toBe('COMPLETED');
    expect(store.tracked.size).toBe(0);
    expect(events.published).toEqual([]);
    expect(store.imp('demo', 'imp1')).toMatchObject({ status: 'COMPLETED', importedCount: 1 });
  });

  it('rejects the whole file when a split has no position, pointing at its row', async () => {
    const { run, store } = setup([HEADER, '2025-01-02,DEPOSIT,CASH.EUR,5000,1,0,EUR', '2025-01-03,BUY,ASML.AS,2,500,0,EUR', '2025-01-01,SPLIT,ASML.AS,2,0,0,EUR'].join('\n'));
    expect(await run()).toBe('FAILED');
    expect(store.transactions).toEqual([]);
    expect(store.imp('demo', 'imp1')!.errors).toEqual([{ row: 3, message: 'Cannot split ASML.AS on 2025-01-01: no position held or invalid ratio' }]);
  });

  it('reports a split against a stored closed position as a file-level error', async () => {
    const ctx = setup(`${HEADER}\n2025-03-01,SPLIT,ASML.AS,2,0,0,EUR\n`);
    ctx.store.transactions.push({
      id: 'old',
      userId: 'demo',
      portfolioId: 'default',
      date: '2025-04-01',
      type: 'BUY',
      symbol: 'ASML.AS',
      quantity: 1,
      price: 1,
      fee: 0,
      currency: 'EUR',
      createdAt: 'x',
    });
    expect(await ctx.run()).toBe('FAILED');
    expect(ctx.store.imp('demo', 'imp1')!.errors).toEqual([{ row: 1, message: 'Cannot split ASML.AS on 2025-03-01: no position held or invalid ratio' }]);
  });

  it('maps a split that only fails later (stored sell) to row 0', async () => {
    const ctx = setup(`${HEADER}\n2025-03-01,SPLIT,ASML.AS,2,0,0,EUR\n`);
    ctx.store.transactions.push(
      { id: 'b', userId: 'demo', portfolioId: 'default', date: '2025-01-01', type: 'BUY', symbol: 'ASML.AS', quantity: 1, price: 1, fee: 0, currency: 'EUR', createdAt: 'a' },
      { id: 's', userId: 'demo', portfolioId: 'default', date: '2025-02-01', type: 'SELL', symbol: 'ASML.AS', quantity: 1, price: 1, fee: 0, currency: 'EUR', createdAt: 'b' },
    );
    expect(await ctx.run()).toBe('FAILED');
    expect(ctx.store.imp('demo', 'imp1')!.errors).toEqual([{ row: 1, message: expect.stringContaining('Cannot split') }]);
  });
});

describe('export / import round trip', () => {
  const stored: Transaction[] = [
    { id: 'a', userId: 'demo', portfolioId: 'default', date: '2025-01-02', type: 'DEPOSIT', symbol: 'CASH.EUR', quantity: 10000, price: 1, fee: 0, currency: 'EUR', createdAt: '2025-01-02T00:00:00.000Z' },
    { id: 'b', userId: 'demo', portfolioId: 'default', date: '2025-01-03', type: 'BUY', symbol: 'AAPL', quantity: 10.5, price: 185.25, fee: 1, currency: 'USD', note: 'First, "core" buy', fxRate: 1.0842, createdAt: '2025-01-03T00:00:00.000Z' },
    { id: 'c', userId: 'demo', portfolioId: 'default', date: '2025-02-03', type: 'SPLIT', symbol: 'AAPL', quantity: 4, price: 0, fee: 0, currency: 'USD', createdAt: '2025-02-03T00:00:00.000Z' },
    { id: 'd', userId: 'demo', portfolioId: 'default', date: '2025-03-03', type: 'DIVIDEND', symbol: 'AAPL', quantity: 42, price: 0.0625, fee: 0.39, currency: 'USD', createdAt: '2025-03-03T00:00:00.000Z' },
    { id: 'e', userId: 'demo', portfolioId: 'default', date: '2025-04-01', type: 'SELL', symbol: 'AAPL', quantity: 2, price: 50, fee: 1, currency: 'USD', createdAt: '2025-04-01T00:00:00.000Z' },
    { id: 'f', userId: 'demo', portfolioId: 'default', date: '2025-04-02', type: 'WITHDRAWAL', symbol: 'CASH.EUR', quantity: 250.5, price: 1, fee: 0, currency: 'EUR', createdAt: '2025-04-02T00:00:00.000Z' },
    { id: 'g', userId: 'demo', portfolioId: 'default', date: '2025-04-03', type: 'INTEREST', symbol: 'CASH.EUR', quantity: 1.25, price: 1, fee: 0, currency: 'EUR', createdAt: '2025-04-03T00:00:00.000Z' },
    { id: 'h', userId: 'demo', portfolioId: 'default', date: '2025-04-04', type: 'FEE', symbol: 'CASH.EUR', quantity: 0.5, price: 1, fee: 0, currency: 'EUR', createdAt: '2025-04-04T00:00:00.000Z' },
  ];

  it('parses exported CSV back into the same transactions', () => {
    const parsed = parseImportCsv(transactionsToCsv(stored));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const expected = stored.map(({ id: _id, userId: _u, portfolioId: _p, createdAt: _c, ...rest }) => rest);
    expect(parsed.rows.map((r) => r.input)).toEqual(expected);
  });

  it('imports an exported file all-or-nothing with identical positions and cash', async () => {
    const { run, store } = setup(transactionsToCsv(stored));
    expect(await run()).toBe('COMPLETED');
    expect(store.imp('demo', 'imp1')).toMatchObject({ status: 'COMPLETED', rowCount: stored.length, importedCount: stored.length });
    expect(buildPositions(store.transactions).get('AAPL')).toEqual(buildPositions(stored).get('AAPL'));
    expect(cashBalances(store.transactions, new Set(['default']))).toEqual(cashBalances(stored, new Set(['default'])));
  });
});
