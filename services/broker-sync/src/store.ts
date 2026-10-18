import {
  cond,
  listByPrefix,
  listTransactions,
  putTransactions,
  registerUser,
  trackTickers,
  type ItemStore,
} from '@portfolio/platform';
import {
  BROKER_ENTITY,
  ENTITY,
  brokerKeys,
  fromItem,
  keys,
  type BrokerSyncState,
  type Portfolio,
  type Transaction,
} from '@portfolio/shared';

/** Persistence used by the sync run and the API's broker endpoints. */
export interface BrokerStore {
  getState(userId: string, portfolioId: string): Promise<BrokerSyncState | null>;
  listStates(userId: string): Promise<BrokerSyncState[]>;
  listUserIds(): Promise<string[]>;
  /** Creates or replaces the state (connect). */
  createState(state: BrokerSyncState): Promise<void>;
  /** Overwrites an existing state; a no-op when it was deleted meanwhile (disconnect during a run). */
  saveState(state: BrokerSyncState): Promise<void>;
  /**
   * Not RUNNING (or RUNNING since before `staleBefore`) -> RUNNING, remembering `runId`. False when another run is active
   * or the state is gone. A run that already holds the lock under the same `runId` gets it again, so a lock step that is
   * delivered twice (at-least-once) does not lock the run out of its own portfolio.
   */
  beginRun(userId: string, portfolioId: string, now: string, staleBefore: string, runId?: string): Promise<boolean>;
  deleteStates(userId: string): Promise<number>;
  listTransactions(userId: string): Promise<Transaction[]>;
  putTransactions(txns: readonly Transaction[]): Promise<void>;
  registerUser(userId: string): Promise<void>;
  trackTickers(tickers: readonly { symbol: string; currency: string }[]): Promise<void>;
  /** Latest ECB rates (units per 1 EUR) written by the prices service; empty when unavailable. */
  getFxRates(): Promise<Record<string, number>>;
  /** Local CLI convenience: creates the portfolio when it does not exist. */
  ensurePortfolio(userId: string, portfolioId: string, name: string, now: string): Promise<void>;
}

const stateItem = (state: BrokerSyncState) => ({
  ...brokerKeys.state(state.userId, state.portfolioId),
  entityType: BROKER_ENTITY,
  ...state,
});

/** BrokerStore on an ItemStore: the key scheme and item shapes of the broker entities, whatever the storage. */
export class ItemBrokerStore implements BrokerStore {
  constructor(private readonly store: ItemStore) {}

  async getState(userId: string, portfolioId: string): Promise<BrokerSyncState | null> {
    const item = await this.store.get(brokerKeys.state(userId, portfolioId), { consistent: true });
    return item ? fromItem<BrokerSyncState>(item) : null;
  }

  listStates(userId: string): Promise<BrokerSyncState[]> {
    return listByPrefix<BrokerSyncState>(this.store, keys.user(userId).PK, brokerKeys.statePrefix);
  }

  async listUserIds(): Promise<string[]> {
    const users = await listByPrefix<{ userId: string }>(this.store, 'USERS', 'USER#');
    return users.map((u) => String(u.userId));
  }

  async createState(state: BrokerSyncState): Promise<void> {
    await this.store.put(stateItem(state));
  }

  async saveState(state: BrokerSyncState): Promise<void> {
    await this.store.put(stateItem(state), { condition: cond.exists });
  }

  async beginRun(userId: string, portfolioId: string, now: string, staleBefore: string, runId?: string): Promise<boolean> {
    const free = [cond.ne('status', 'RUNNING'), cond.attrMissing('runStartedAt'), cond.lt('runStartedAt', staleBefore)];
    const claimed = await this.store.update(
      brokerKeys.state(userId, portfolioId),
      { set: { status: 'RUNNING', runStartedAt: now, updatedAt: now, ...(runId ? { runId } : {}) }, ...(runId ? {} : { remove: ['runId'] }) },
      { condition: cond.and(cond.exists, cond.or(...free, ...(runId ? [cond.eq('runId', runId)] : []))) },
    );
    return claimed !== undefined;
  }

  async deleteStates(userId: string): Promise<number> {
    const states = await this.listStates(userId);
    await Promise.all(states.map((s) => this.store.delete(brokerKeys.state(userId, s.portfolioId))));
    return states.length;
  }

  listTransactions(userId: string): Promise<Transaction[]> {
    return listTransactions(this.store, userId);
  }

  /** Idempotent (deterministic keys): safe to repeat after a failure. */
  putTransactions(txns: readonly Transaction[]): Promise<void> {
    return putTransactions(this.store, txns);
  }

  registerUser(userId: string): Promise<void> {
    return registerUser(this.store, userId, new Date().toISOString());
  }

  trackTickers(tickers: readonly { symbol: string; currency: string }[]): Promise<void> {
    return trackTickers(this.store, tickers, new Date().toISOString());
  }

  async getFxRates(): Promise<Record<string, number>> {
    const rates: unknown = (await this.store.get(keys.fx('EUR')))?.rates;
    return rates && typeof rates === 'object' ? (rates as Record<string, number>) : {};
  }

  async ensurePortfolio(userId: string, portfolioId: string, name: string, now: string): Promise<void> {
    const item: Portfolio = { portfolioId, userId, name, createdAt: now, updatedAt: now };
    await this.store.put({ ...keys.portfolio(userId, portfolioId), entityType: ENTITY.portfolio, ...item }, { condition: cond.notExists });
  }
}
