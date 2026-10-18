import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryItemStore } from '@portfolio/platform';
import type { ImportStatus, Transaction } from '@portfolio/shared';
import { ItemIngestStore } from './store.js';

const NOW = '2026-06-15T12:00:00.000Z';

const setup = () => {
  const items = new MemoryItemStore();
  return { items, store: new ItemIngestStore(items) };
};

const importItem = (over: Partial<ImportStatus> = {}) => ({
  PK: 'USER#u',
  SK: 'IMPORT#i',
  entityType: 'IMPORT',
  importId: 'i',
  userId: 'u',
  portfolioId: 'p1',
  fileName: 'f.csv',
  status: 'PENDING',
  createdAt: 'c',
  updatedAt: 'c',
  ...over,
});

const txn = (i: number): Transaction => ({
  id: `imp-${i}`,
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
  importId: 'imp',
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

describe('ItemIngestStore reads', () => {
  it('reads the IMPORT item consistently without key attributes, or null', async () => {
    const { items, store } = setup();
    const get = vi.spyOn(items, 'get');
    expect(await store.getImport('u', 'i')).toBeNull();
    await items.put(importItem());
    expect(await store.getImport('u', 'i')).toMatchObject({ importId: 'i', userId: 'u', status: 'PENDING' });
    expect(await store.getImport('u', 'i')).not.toHaveProperty('PK');
    expect(get).toHaveBeenCalledWith({ PK: 'USER#u', SK: 'IMPORT#i' }, { consistent: true });
  });

  it('checks whether the PORTFOLIO item exists, consistently', async () => {
    const { items, store } = setup();
    const get = vi.spyOn(items, 'get');
    await items.put({ PK: 'USER#u', SK: 'PORTFOLIO#p1' });
    expect(await store.portfolioExists('u', 'p1')).toBe(true);
    expect(await store.portfolioExists('u', 'gone')).toBe(false);
    expect(get).toHaveBeenCalledWith({ PK: 'USER#u', SK: 'PORTFOLIO#p1' }, { consistent: true });
  });

  it('lists the transactions of the user (every portfolio) without key attributes', async () => {
    const { store } = setup();
    await store.putTransactions([txn(1), { ...txn(2), portfolioId: 'p2' }]);
    expect((await store.listTransactions('u')).map((t) => t.id)).toEqual(['imp-1', 'imp-2']);
    expect(await store.listTransactions('other')).toEqual([]);
  });
});

describe('ItemIngestStore.markProcessing', () => {
  it('moves PENDING and PROCESSING to PROCESSING and stamps updatedAt', async () => {
    const { items, store } = setup();
    await items.put(importItem());
    expect(await store.markProcessing('u', 'i')).toBe(true);
    expect(await items.get({ PK: 'USER#u', SK: 'IMPORT#i' })).toMatchObject({ status: 'PROCESSING', updatedAt: NOW });
    expect(await store.markProcessing('u', 'i')).toBe(true);
  });

  it('refuses a terminal or missing import', async () => {
    const { items, store } = setup();
    expect(await store.markProcessing('u', 'i')).toBe(false);
    expect(await items.get({ PK: 'USER#u', SK: 'IMPORT#i' })).toBeUndefined();
    for (const status of ['COMPLETED', 'FAILED']) {
      await items.put(importItem({ status: status as ImportStatus['status'] }));
      expect(await store.markProcessing('u', 'i')).toBe(false);
      expect((await items.get({ PK: 'USER#u', SK: 'IMPORT#i' }))?.status).toBe(status);
    }
  });

  it('surfaces storage errors (e.g. throttling) so the message is retried', async () => {
    const { items, store } = setup();
    vi.spyOn(items, 'update').mockRejectedValue(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }));
    await expect(store.markProcessing('u', 'i')).rejects.toThrow('Rate exceeded');
  });
});

describe('ItemIngestStore status updates', () => {
  it('markFailed stores the errors with importedCount 0', async () => {
    const { items, store } = setup();
    await items.put(importItem({ status: 'PROCESSING' }));
    await store.markFailed('u', 'i', 3, [{ row: 2, message: 'bad' }]);
    expect(await items.get({ PK: 'USER#u', SK: 'IMPORT#i' })).toMatchObject({
      status: 'FAILED',
      rowCount: 3,
      importedCount: 0,
      errors: [{ row: 2, message: 'bad' }],
      updatedAt: NOW,
    });
  });

  it('markCompleted stores the counts and removes previous errors', async () => {
    const { items, store } = setup();
    await items.put({ ...importItem({ status: 'PROCESSING' }), errors: [{ row: 1, message: 'old' }] });
    await store.markCompleted('u', 'i', 4, 4);
    const done = await items.get({ PK: 'USER#u', SK: 'IMPORT#i' });
    expect(done).toMatchObject({ status: 'COMPLETED', rowCount: 4, importedCount: 4, updatedAt: NOW });
    expect(done).not.toHaveProperty('errors');
  });
});

describe('ItemIngestStore registry and writes', () => {
  it('registerUser upserts the registry item keeping the original createdAt', async () => {
    const { items, store } = setup();
    await store.registerUser('u');
    vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
    await store.registerUser('u');
    expect(await items.get({ PK: 'USERS', SK: 'USER#u' })).toMatchObject({ entityType: 'USER', userId: 'u', createdAt: NOW, updatedAt: '2026-07-01T00:00:00.000Z' });
  });

  it('trackTickers upserts one item per ticker without overwriting an existing currency', async () => {
    const { items, store } = setup();
    await store.trackTickers([{ symbol: 'AAPL', currency: 'USD' }, { symbol: 'CASH.EUR', currency: 'EUR' }]);
    await store.trackTickers([{ symbol: 'AAPL', currency: 'EUR' }]);
    expect(items.size).toBe(1);
    expect(await items.get({ PK: 'TRACKED', SK: 'TICKER#AAPL' })).toMatchObject({ entityType: 'TRACKED_TICKER', symbol: 'AAPL', currency: 'USD' });
    await store.trackTickers([]);
    expect(items.size).toBe(1);
  });

  it('putTransactions writes nothing for an empty list and stores items with keys and entity type', async () => {
    const { items, store } = setup();
    await store.putTransactions([]);
    expect(items.size).toBe(0);
    await store.putTransactions(Array.from({ length: 60 }, (_, i) => ({ ...txn(i + 1), fxRate: 1.1 })));
    expect(items.size).toBe(60);
    expect(await items.get({ PK: 'USER#u', SK: 'TXN#p1#2025-01-01#imp-1' })).toMatchObject({ entityType: 'TRANSACTION', id: 'imp-1', fxRate: 1.1 });
  });

  it('propagates write failures, so the import is redelivered', async () => {
    const { items, store } = setup();
    vi.spyOn(items, 'batchWrite').mockRejectedValue(new Error('boom'));
    await expect(store.putTransactions([txn(1)])).rejects.toThrow('boom');
  });
});
