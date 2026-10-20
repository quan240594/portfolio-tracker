import { MemoryItemStore } from '@portfolio/platform';
import { describe, expect, it } from 'vitest';
import { ItemQuoteStore } from './quote-store.js';

const quote = { symbol: 'AAPL', price: 212.5, previousClose: 210, currency: 'USD', asOf: '2026-10-20T10:15:00.000Z', source: 't212' };

describe('ItemQuoteStore', () => {
  it('round-trips quotes and the status, ignoring missing symbols and corrupt quote items', async () => {
    const items = new MemoryItemStore();
    const store = new ItemQuoteStore(items);
    expect(await store.latest([])).toEqual(new Map());
    expect(await store.getStatus('u1')).toBeNull();
    await store.save([quote], { userId: 'u1', state: 'OK', lastAttemptAt: quote.asOf, failures: 0 });
    items.load([
      { PK: 'TICKER#BAD1', SK: 'QUOTE#LATEST', symbol: 'BAD1', price: 'x', previousClose: 1, currency: 'USD', asOf: quote.asOf },
      { PK: 'TICKER#BAD2', SK: 'QUOTE#LATEST', symbol: 'BAD2', price: 1, previousClose: 1, currency: 'USD' },
      { PK: 'TICKER#BAD3', SK: 'QUOTE#LATEST', price: 1, previousClose: 1, currency: 'USD', asOf: quote.asOf },
      { PK: 'TICKER#BAD4', SK: 'QUOTE#LATEST', symbol: 'BAD4', price: 1, previousClose: Number.NaN, currency: 'USD', asOf: quote.asOf },
      { PK: 'TICKER#NOSRC', SK: 'QUOTE#LATEST', symbol: 'NOSRC', price: 1, previousClose: 1, currency: 'USD', asOf: quote.asOf },
    ]);
    const found = await store.latest(['AAPL', 'MISSING', 'BAD1', 'BAD2', 'BAD3', 'BAD4', 'NOSRC']);
    expect([...found.keys()]).toEqual(['AAPL', 'NOSRC']);
    expect(found.get('AAPL')).toEqual(quote);
    expect(found.get('NOSRC')?.source).toBe('');
    expect(await store.getStatus('u1')).toEqual({ userId: 'u1', state: 'OK', lastAttemptAt: quote.asOf, failures: 0 });
  });

  it('stores the same item shape as the price service: PK TICKER#symbol, SK QUOTE#LATEST, entityType QUOTE', async () => {
    const items = new MemoryItemStore();
    await new ItemQuoteStore(items).save([quote], { userId: 'u1', state: 'OK', lastAttemptAt: quote.asOf, failures: 0 });
    expect(items.snapshot().find((item) => item.PK === 'TICKER#AAPL')).toEqual({ PK: 'TICKER#AAPL', SK: 'QUOTE#LATEST', entityType: 'QUOTE', ...quote });
    expect(items.snapshot().find((item) => item.PK === 'USER#u1')).toMatchObject({ SK: 'QUOTESYNC#trading212', entityType: 'T212_QUOTE_STATUS' });
  });
});
