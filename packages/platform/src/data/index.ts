/**
 * Domain helpers on top of ItemStore that several services share (the API, the ingest and the broker sync all
 * register users, track tickers and read/write transactions the same way). Written once, so every adapter gets the
 * same item shapes and keys.
 */
import { ENTITY, fromItem, isMarketSymbol, keys, transactionItem, type Transaction } from '@portfolio/shared';
import { queryAll, type ItemStore, type ReadOptions } from '../item-store.js';

/** Every item under `pk` whose sort key starts with `prefix`, without the key attributes. */
export async function listByPrefix<T>(store: ItemStore, pk: string, prefix: string, options?: ReadOptions): Promise<T[]> {
  const items = await queryAll(store, { pk, sk: { beginsWith: prefix }, ...options });
  return items.map((item) => fromItem<T>(item));
}

/** Upserts the user registry row, preserving `createdAt` on later writes. */
export async function registerUser(store: ItemStore, userId: string, now: string): Promise<void> {
  await store.update(keys.userRegistry(userId), {
    set: { entityType: ENTITY.user, userId, updatedAt: now },
    setIfAbsent: { createdAt: now },
  });
}

/**
 * One upsert per ticker, preserving `currency` and `createdAt` on later writes. Cash (`CASH.*`) and custom (`CUSTOM:*`)
 * symbols have no price feed and are never registered. `currency` may be omitted (watchlist symbols).
 */
export async function trackTickers(store: ItemStore, tickers: readonly { symbol: string; currency?: string }[], now: string): Promise<void> {
  await Promise.all(
    tickers
      .filter((t) => isMarketSymbol(t.symbol))
      .map((t) =>
        store.update(keys.trackedTicker(t.symbol), {
          set: { entityType: ENTITY.trackedTicker, symbol: t.symbol, updatedAt: now },
          setIfAbsent: { createdAt: now, ...(t.currency ? { currency: t.currency } : {}) },
        }),
      ),
  );
}

/** Transactions of one portfolio, or of every portfolio of the user when `portfolioId` is omitted. */
export function listTransactions(store: ItemStore, userId: string, portfolioId?: string): Promise<Transaction[]> {
  const prefix = portfolioId === undefined ? keys.transactionPrefix : keys.portfolioTransactionPrefix(portfolioId);
  return listByPrefix<Transaction>(store, keys.user(userId).PK, prefix);
}

/** Idempotent (deterministic keys): safe to repeat after a failure. */
export function putTransactions(store: ItemStore, transactions: readonly Transaction[]): Promise<void> {
  return store.batchWrite(transactions.map((t) => ({ type: 'put', item: transactionItem(t) })));
}
