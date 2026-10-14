import type { BrokerSyncState, Transaction } from '@portfolio/shared';
import type { BrokerStore } from './store.js';

/**
 * In-memory BrokerStore: backs `--dry-run` (nothing leaves the process, no AWS needed) and the unit tests.
 * `existing` seeds transactions already stored for the user (e.g. other portfolios) for validation.
 */
export class MemoryBrokerStore implements BrokerStore {
  readonly states = new Map<string, BrokerSyncState>();
  readonly transactions = new Map<string, Transaction>();
  readonly tracked = new Map<string, string>();
  readonly users = new Set<string>();
  fxRates: Record<string, number> = {};

  constructor(existing: readonly Transaction[] = []) {
    for (const t of existing) this.transactions.set(`${t.userId}|${t.portfolioId}|${t.id}`, t);
  }

  private static readonly key = (userId: string, portfolioId: string) => `${userId}|${portfolioId}`;

  getState(userId: string, portfolioId: string): Promise<BrokerSyncState | null> {
    return Promise.resolve(this.states.get(MemoryBrokerStore.key(userId, portfolioId)) ?? null);
  }

  listStates(userId: string): Promise<BrokerSyncState[]> {
    return Promise.resolve([...this.states.values()].filter((s) => s.userId === userId));
  }

  listUserIds(): Promise<string[]> {
    return Promise.resolve([...new Set([...this.states.values()].map((s) => s.userId))]);
  }

  createState(state: BrokerSyncState): Promise<void> {
    this.states.set(MemoryBrokerStore.key(state.userId, state.portfolioId), state);
    return Promise.resolve();
  }

  saveState(state: BrokerSyncState): Promise<void> {
    const key = MemoryBrokerStore.key(state.userId, state.portfolioId);
    if (this.states.has(key)) this.states.set(key, state);
    return Promise.resolve();
  }

  beginRun(userId: string, portfolioId: string, now: string, staleBefore: string): Promise<boolean> {
    const key = MemoryBrokerStore.key(userId, portfolioId);
    const state = this.states.get(key);
    if (!state) return Promise.resolve(false);
    const busy = state.status === 'RUNNING' && state.runStartedAt !== undefined && state.runStartedAt >= staleBefore;
    if (busy) return Promise.resolve(false);
    this.states.set(key, { ...state, status: 'RUNNING', runStartedAt: now, updatedAt: now });
    return Promise.resolve(true);
  }

  deleteStates(userId: string): Promise<number> {
    const doomed = [...this.states.entries()].filter(([, s]) => s.userId === userId);
    for (const [key] of doomed) this.states.delete(key);
    return Promise.resolve(doomed.length);
  }

  listTransactions(userId: string): Promise<Transaction[]> {
    return Promise.resolve([...this.transactions.values()].filter((t) => t.userId === userId));
  }

  putTransactions(txns: readonly Transaction[]): Promise<void> {
    for (const t of txns) this.transactions.set(`${t.userId}|${t.portfolioId}|${t.id}`, t);
    return Promise.resolve();
  }

  registerUser(userId: string): Promise<void> {
    this.users.add(userId);
    return Promise.resolve();
  }

  trackTickers(tickers: readonly { symbol: string; currency: string }[]): Promise<void> {
    for (const t of tickers) this.tracked.set(t.symbol, t.currency);
    return Promise.resolve();
  }

  getFxRates(): Promise<Record<string, number>> {
    return Promise.resolve(this.fxRates);
  }

  ensurePortfolio(): Promise<void> {
    return Promise.resolve();
  }
}
