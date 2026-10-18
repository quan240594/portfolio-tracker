import { MemoryItemStore } from '@portfolio/platform';
import { ENTITY, fromItem, keys, transactionItem, type BrokerSyncState, type Transaction } from '@portfolio/shared';
import { ItemBrokerStore } from './store.js';

/**
 * In-memory BrokerStore: backs `--dry-run` (nothing leaves the process, no cloud needed) and the unit tests. It is the
 * regular `ItemBrokerStore` on a `MemoryItemStore`, plus read-only views of what was written.
 * `existing` seeds transactions already stored for the user (e.g. other portfolios) for validation.
 */
export class MemoryBrokerStore extends ItemBrokerStore {
  readonly items: MemoryItemStore;

  constructor(existing: readonly Transaction[] = []) {
    const items = new MemoryItemStore().load(existing.map((transaction) => transactionItem(transaction)));
    super(items);
    this.items = items;
  }

  private view(test: (item: { PK: string; SK: string }) => boolean) {
    return this.items.snapshot().filter(test);
  }

  get states(): Map<string, BrokerSyncState> {
    return new Map(this.view((i) => i.SK.startsWith('BROKER#')).map((i) => [`${i.userId}|${i.portfolioId}`, fromItem<BrokerSyncState>(i)]));
  }

  get transactions(): Map<string, Transaction> {
    return new Map(this.view((i) => i.SK.startsWith('TXN#')).map((i) => [`${i.userId}|${i.portfolioId}|${i.id}`, fromItem<Transaction>(i)]));
  }

  /** Tracked tickers: symbol -> currency. */
  get tracked(): Map<string, string> {
    return new Map(this.view((i) => i.PK === 'TRACKED').map((i) => [String(i.symbol), String(i.currency ?? '')]));
  }

  get users(): Set<string> {
    return new Set(this.view((i) => i.PK === 'USERS').map((i) => String(i.userId)));
  }

  /** Latest ECB rates the sync falls back on. */
  set fxRates(rates: Record<string, number>) {
    this.items.load([{ ...keys.fx('EUR'), entityType: ENTITY.fx, base: 'EUR', rates }]);
  }
}
