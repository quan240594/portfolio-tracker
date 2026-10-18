/**
 * Pure helpers for the single-table item layout, shared by every service. Free of any storage SDK (this package is
 * also bundled into the web app); writes go through the `ItemStore` port of @portfolio/platform.
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
