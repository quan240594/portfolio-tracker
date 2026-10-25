import { listByPrefix, type ItemStore } from '@portfolio/platform';
import { dropUndefined } from './util.js';
import {
  EARNINGS_ENTITY,
  EARNINGS_KEEP_QUARTERS,
  earningsKeys,
  fromItem,
  type EarningsBackfillMarker,
  type EarningsHeldCache,
  type EarningsSecBlock,
  type EarningsSummary,
  type EarningsSymbolState,
} from '@portfolio/shared';

/**
 * Persistence of the earnings feature on an `ItemStore`. Public data, so it lives under the ticker partition (`TICKER#{symbol}`) next to the
 * quotes and dividends: `EARNSUM#{reportDate}` per release, `EARNSTATE` per symbol, and two global items under `EARNINGS`.
 * Every write is a put of a deterministic key, so a redelivered job step stores the same thing again.
 */
export class EarningsRepository {
  constructor(private readonly store: ItemStore) {}

  async getSummary(symbol: string, reportDate: string): Promise<EarningsSummary | null> {
    const item = await this.store.get(earningsKeys.summary(symbol, reportDate), { consistent: true });
    return item ? fromItem<EarningsSummary>(item) : null;
  }

  /** The newest stored summaries of a symbol, newest first. */
  async latest(symbol: string, limit: number): Promise<EarningsSummary[]> {
    const page = await this.store.query({ pk: earningsKeys.tickerPk(symbol), sk: { beginsWith: earningsKeys.summaryPrefix }, reverse: true, limit, consistent: true });
    return page.items.map((item) => fromItem<EarningsSummary>(item));
  }

  async putSummary(summary: EarningsSummary): Promise<void> {
    await this.store.put({ ...earningsKeys.summary(summary.symbol, summary.reportDate), entityType: EARNINGS_ENTITY.summary, ...dropUndefined(summary) });
  }

  /** Deletes everything but the newest `keep` summaries of the symbol; resolves how many were deleted. */
  async prune(symbol: string, keep = EARNINGS_KEEP_QUARTERS): Promise<number> {
    const all = await listByPrefix<EarningsSummary>(this.store, earningsKeys.tickerPk(symbol), earningsKeys.summaryPrefix, { consistent: true });
    const excess = all.map((summary) => summary.reportDate).toSorted((a, b) => b.localeCompare(a)).slice(keep);
    await this.store.batchWrite(excess.map((reportDate) => ({ type: 'delete', key: earningsKeys.summary(symbol, reportDate) })));
    return excess.length;
  }

  async getState(symbol: string): Promise<EarningsSymbolState | null> {
    const item = await this.store.get(earningsKeys.state(symbol), { consistent: true });
    return item ? fromItem<EarningsSymbolState>(item) : null;
  }

  async getStates(symbols: readonly string[]): Promise<Map<string, EarningsSymbolState>> {
    const items = await this.store.getMany(symbols.map((symbol) => earningsKeys.state(symbol)));
    const states = items.map((item) => fromItem<EarningsSymbolState>(item));
    return new Map(states.map((state) => [state.symbol, state]));
  }

  /** Stores `patch` over the symbol's state (a missing state starts empty). */
  async patchState(symbol: string, patch: Partial<EarningsSymbolState>, now: Date): Promise<EarningsSymbolState> {
    const current = (await this.getState(symbol)) ?? { symbol, updatedAt: now.toISOString() };
    const next: EarningsSymbolState = { ...current, ...patch, symbol, updatedAt: now.toISOString() };
    for (const key of Object.keys(next) as (keyof EarningsSymbolState)[]) if (next[key] === undefined) delete next[key];
    await this.store.put({ ...earningsKeys.state(symbol), entityType: EARNINGS_ENTITY.state, ...next });
    return next;
  }

  async getSecBlock(): Promise<EarningsSecBlock | null> {
    const item = await this.store.get(earningsKeys.sec, { consistent: true });
    return item ? fromItem<EarningsSecBlock>(item) : null;
  }

  async putSecBlock(block: EarningsSecBlock): Promise<void> {
    await this.store.put({ ...earningsKeys.sec, entityType: EARNINGS_ENTITY.sec, ...block });
  }

  async getHeld(): Promise<EarningsHeldCache | null> {
    const item = await this.store.get(earningsKeys.held, { consistent: true });
    return item ? fromItem<EarningsHeldCache>(item) : null;
  }

  async putHeld(cache: EarningsHeldCache): Promise<void> {
    await this.store.put({ ...earningsKeys.held, entityType: EARNINGS_ENTITY.held, ...dropUndefined(cache) });
  }

  async getBackfill(): Promise<EarningsBackfillMarker | null> {
    const item = await this.store.get(earningsKeys.backfill, { consistent: true });
    return item ? fromItem<EarningsBackfillMarker>(item) : null;
  }

  async putBackfill(marker: EarningsBackfillMarker): Promise<void> {
    await this.store.put({ ...earningsKeys.backfill, entityType: EARNINGS_ENTITY.backfill, ...dropUndefined(marker) });
  }
}
