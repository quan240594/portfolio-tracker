/**
 * Pure DynamoDB item/command-input builders shared by the API and ingest services.
 * Deliberately free of AWS SDK imports (this package is also bundled into the web app): callers wrap the returned
 * inputs in their own `UpdateCommand` and send them with their own document client.
 */
import { ENTITY, keys } from './keys.js';
import type { Transaction } from './types.js';

const KEY_ATTRS = new Set(['PK', 'SK', 'entityType']);

/** Strips the single-table key attributes from an item. */
export function fromItem<T>(item: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!KEY_ATTRS.has(k)) out[k] = v;
  return out as T;
}

/** The full stored item (keys + entityType + fields) for a transaction. */
export const transactionItem = (t: Transaction) => ({
  ...keys.transaction(t.userId, t.portfolioId, t.date, t.id),
  entityType: ENTITY.transaction,
  ...t,
});

/** Structurally compatible with `UpdateCommandInput` from `@aws-sdk/lib-dynamodb`. */
export interface UpdateInput {
  TableName: string;
  Key: { PK: string; SK: string };
  UpdateExpression: string;
  ExpressionAttributeValues: Record<string, unknown>;
}

/** Upserts the user registry row, preserving `createdAt` on later writes. */
export const registerUserUpdate = (tableName: string, userId: string, now: string): UpdateInput => ({
  TableName: tableName,
  Key: keys.userRegistry(userId),
  UpdateExpression: 'SET entityType = :t, userId = :u, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
  ExpressionAttributeValues: { ':t': ENTITY.user, ':u': userId, ':now': now },
});

/** One upsert per ticker, preserving `currency` and `createdAt` on later writes. */
export const trackTickerUpdates = (
  tableName: string,
  tickers: readonly { symbol: string; currency: string }[],
  now: string,
): UpdateInput[] =>
  tickers.map((t) => ({
    TableName: tableName,
    Key: keys.trackedTicker(t.symbol),
    UpdateExpression:
      'SET entityType = :t, symbol = :s, currency = if_not_exists(currency, :c), updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
    ExpressionAttributeValues: { ':t': ENTITY.trackedTicker, ':s': t.symbol, ':c': t.currency, ':now': now },
  }));
