import { describe, expect, it } from 'vitest';
import { ENTITY, fromItem, keys, transactionItem } from './index.js';
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
