import { describe, expect, it } from 'vitest';
import { ENTITY, fromItem, keys, registerUserUpdate, trackTickerUpdates, transactionItem } from './index.js';
import type { Transaction } from './types.js';

describe('fromItem', () => {
  it('strips only the top-level key attributes', () => {
    expect(fromItem({ PK: 'a', SK: 'b', entityType: 'c', id: 1, nested: { PK: 'kept' } })).toEqual({ id: 1, nested: { PK: 'kept' } });
  });
});

describe('transactionItem', () => {
  it('adds keys and entityType in front of the transaction fields', () => {
    const t = { id: 't1', userId: 'u1', portfolioId: 'p1', date: '2026-01-02', symbol: 'AAPL' } as unknown as Transaction;
    expect(transactionItem(t)).toEqual({ ...keys.transaction('u1', 'p1', '2026-01-02', 't1'), entityType: ENTITY.transaction, ...t });
  });
});

describe('registerUserUpdate', () => {
  it('upserts the registry row and keeps createdAt on later writes', () => {
    const input = registerUserUpdate('tbl', 'u1', '2026-01-01T00:00:00.000Z');
    expect(input).toEqual({
      TableName: 'tbl',
      Key: keys.userRegistry('u1'),
      UpdateExpression: 'SET entityType = :t, userId = :u, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeValues: { ':t': ENTITY.user, ':u': 'u1', ':now': '2026-01-01T00:00:00.000Z' },
    });
  });
});

describe('trackTickerUpdates', () => {
  it('builds one upsert per ticker that preserves currency and createdAt', () => {
    const inputs = trackTickerUpdates('tbl', [{ symbol: 'AAPL', currency: 'USD' }, { symbol: 'ASML.AS', currency: 'EUR' }], 'now');
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual({
      TableName: 'tbl',
      Key: keys.trackedTicker('ASML.AS'),
      UpdateExpression:
        'SET entityType = :t, symbol = :s, currency = if_not_exists(currency, :c), updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeValues: { ':t': ENTITY.trackedTicker, ':s': 'ASML.AS', ':c': 'EUR', ':now': 'now' },
    });
  });

  it('returns nothing for no tickers', () => {
    expect(trackTickerUpdates('tbl', [], 'now')).toEqual([]);
  });
});
