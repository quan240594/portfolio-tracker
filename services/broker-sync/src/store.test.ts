import { describe, expect, it, vi } from 'vitest';
import { MemoryItemStore } from '@portfolio/platform';
import type { BrokerSyncState, Transaction } from '@portfolio/shared';
import { ItemBrokerStore } from './store.js';

const setup = () => {
  const items = new MemoryItemStore();
  return { items, store: new ItemBrokerStore(items) };
};

const state: BrokerSyncState = {
  userId: 'u1',
  portfolioId: 'p1',
  broker: 'trading212',
  environment: 'live',
  status: 'CONNECTED',
  connectedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const txn = (id: string, portfolioId = 'p1'): Transaction => ({ id, userId: 'u1', portfolioId, date: '2026-01-02', type: 'BUY', symbol: 'AAPL', quantity: 1, price: 1, fee: 0, currency: 'USD', createdAt: '2026-01-02T10:00:00.000Z' });

describe('ItemBrokerStore state', () => {
  it('stores a state under the broker key and reads it back consistently without the key attributes', async () => {
    const { items, store } = setup();
    const get = vi.spyOn(items, 'get');
    expect(await store.getState('u1', 'p1')).toBeNull();
    await store.createState(state);
    expect(await items.get({ PK: 'USER#u1', SK: 'BROKER#trading212#p1' })).toEqual({ PK: 'USER#u1', SK: 'BROKER#trading212#p1', entityType: 'BROKER_STATE', ...state });
    expect(await store.getState('u1', 'p1')).toEqual(state);
    expect(get).toHaveBeenCalledWith({ PK: 'USER#u1', SK: 'BROKER#trading212#p1' }, { consistent: true });
  });

  it('replaces a state, but does not resurrect one that was deleted meanwhile', async () => {
    const { store } = setup();
    await store.saveState(state);
    expect(await store.getState('u1', 'p1')).toBeNull();
    await store.createState(state);
    await store.saveState({ ...state, status: 'SUCCEEDED' });
    expect((await store.getState('u1', 'p1'))!.status).toBe('SUCCEEDED');
  });

  it('takes the run lock only when the state exists and is idle, unlocked or stale', async () => {
    const { store } = setup();
    expect(await store.beginRun('u1', 'p1', 'now', 'stale')).toBe(false);
    await store.createState(state);
    expect(await store.beginRun('u1', 'p1', '2026-02-01', '2026-01-01')).toBe(true);
    expect(await store.getState('u1', 'p1')).toMatchObject({ status: 'RUNNING', runStartedAt: '2026-02-01', updatedAt: '2026-02-01' });
    expect(await store.beginRun('u1', 'p1', '2026-02-02', '2026-01-01')).toBe(false);
    expect(await store.beginRun('u1', 'p1', '2026-02-02', '2026-03-01')).toBe(true);
    await store.saveState({ ...state, status: 'RUNNING' });
    expect(await store.beginRun('u1', 'p1', 'n', 's')).toBe(true);
  });

  it('lists the states of a user and the registered users', async () => {
    const { store } = setup();
    await store.createState(state);
    await store.createState({ ...state, portfolioId: 'p2' });
    await store.createState({ ...state, userId: 'u2' });
    expect((await store.listStates('u1')).map((s) => s.portfolioId)).toEqual(['p1', 'p2']);
    expect(await store.listUserIds()).toEqual([]);
    await store.registerUser('u1');
    await store.registerUser('u2');
    expect(await store.listUserIds()).toEqual(['u1', 'u2']);
  });

  it('deletes all states of a user and reports how many', async () => {
    const { store } = setup();
    await store.createState(state);
    await store.createState({ ...state, portfolioId: 'p2' });
    expect(await store.deleteStates('u1')).toBe(2);
    expect(await store.deleteStates('u1')).toBe(0);
    expect(await store.listStates('u1')).toEqual([]);
  });
});

describe('ItemBrokerStore transactions', () => {
  it('writes transactions under the transaction keys and lists them for the whole user', async () => {
    const { items, store } = setup();
    await store.putTransactions([txn('a'), txn('b', 'p2')]);
    expect(await items.get({ PK: 'USER#u1', SK: 'TXN#p1#2026-01-02#a' })).toMatchObject({ entityType: 'TRANSACTION', id: 'a' });
    expect((await store.listTransactions('u1')).map((t) => t.id)).toEqual(['a', 'b']);
    expect(await store.listTransactions('u2')).toEqual([]);
  });

  it('rewrites the same transaction idempotently', async () => {
    const { items, store } = setup();
    await store.putTransactions([txn('a')]);
    await store.putTransactions([{ ...txn('a'), price: 2 }]);
    expect(items.size).toBe(1);
    expect((await store.listTransactions('u1'))[0]!.price).toBe(2);
  });
});

describe('ItemBrokerStore registry, fx and portfolios', () => {
  it('registers the user and tracks tickers, keeping the first currency', async () => {
    const { items, store } = setup();
    await store.registerUser('u1');
    await store.trackTickers([{ symbol: 'AAPL', currency: 'USD' }, { symbol: 'CASH.EUR', currency: 'EUR' }]);
    await store.trackTickers([{ symbol: 'AAPL', currency: 'EUR' }]);
    expect(await items.get({ PK: 'USERS', SK: 'USER#u1' })).toMatchObject({ entityType: 'USER', userId: 'u1' });
    expect(await items.get({ PK: 'TRACKED', SK: 'TICKER#AAPL' })).toMatchObject({ entityType: 'TRACKED_TICKER', currency: 'USD' });
    expect(await items.get({ PK: 'TRACKED', SK: 'TICKER#CASH.EUR' })).toBeUndefined();
  });

  it('reads the latest ECB rates, or nothing when they are missing or malformed', async () => {
    const { items, store } = setup();
    expect(await store.getFxRates()).toEqual({});
    await items.put({ PK: 'FX#EUR', SK: 'LATEST', rates: 'oops' });
    expect(await store.getFxRates()).toEqual({});
    await items.put({ PK: 'FX#EUR', SK: 'LATEST', rates: { USD: 1.1 } });
    expect(await store.getFxRates()).toEqual({ USD: 1.1 });
  });

  it('creates the portfolio of the CLI only once', async () => {
    const { items, store } = setup();
    await store.ensurePortfolio('u1', 'p1', 'Trading 212', 't1');
    await store.ensurePortfolio('u1', 'p1', 'Other', 't2');
    expect(await items.get({ PK: 'USER#u1', SK: 'PORTFOLIO#p1' })).toEqual({ PK: 'USER#u1', SK: 'PORTFOLIO#p1', entityType: 'PORTFOLIO', portfolioId: 'p1', userId: 'u1', name: 'Trading 212', createdAt: 't1', updatedAt: 't1' });
  });
});
