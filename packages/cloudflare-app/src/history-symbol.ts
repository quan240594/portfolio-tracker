/**
 * Wiring of the owner's price history symbol (`PUT /classification/{symbol}` with `historySymbol`) to the price jobs. The classification
 * itself is stored by the API; this keeps the copy the price jobs read (one item per held symbol, see `HistorySymbolRecord`) and starts
 * the enrichment that fetches the history, so the owner sees it after one run instead of at the next daily one. No business logic:
 * the fetch, the currency check and the precedence of the rows live in `@portfolio/prices`.
 */
import { JOBS, guardJob, logger, type BudgetGuard, type ItemStore, type JobQueue } from '@portfolio/platform';
import type { HistorySymbolDeps } from '@portfolio/api';
import { describeDiagnosticError } from '@portfolio/cloudflare';
import { MAX_ATTEMPTS_PER_DAY, PriceRepository, providerOf } from '@portfolio/prices';

export interface HistorySymbolContext {
  items: ItemStore;
  /** Where the enrichment is started; absent when no price service is registered (the item is still kept for when there is one). */
  queue?: JobQueue;
  guard: BudgetGuard;
  now: () => Date;
}

/**
 * The API's hook (`Deps.historySymbols`). A cleared symbol only forgets the item (the rows it stored stay, marked `override`). A set one
 * is stored as `pending` and an `enrichTransactions` job is queued for the held symbol unless: no price service is registered, the symbol
 * was already tried `MAX_ATTEMPTS_PER_DAY` times today, the provider that serves the history symbol is limited until its reset, or the
 * budget guard refuses enrichment (`guardJob`). The daily refresh hands every still pending symbol to an enrichment job, so a skipped
 * one is only late. A failure to queue never fails the save.
 */
export function createHistorySymbolApi({ items, queue, guard, now }: Readonly<HistorySymbolContext>): HistorySymbolDeps {
  const repo = new PriceRepository(items);
  return {
    async changed(symbol, historySymbol) {
      if (historySymbol === null) {
        await repo.clearHistorySymbol(symbol);
        return;
      }
      const at = now();
      await repo.putHistorySymbol({ symbol, historySymbol, status: 'pending', reason: null, setAt: at.toISOString() });
      if (queue === undefined) return;
      try {
        const provider = providerOf(historySymbol);
        const [tries, blocked, decision] = await Promise.all([repo.attemptsOn('override', [symbol], at.toISOString().slice(0, 10)), repo.blockedProviders([provider], at), guardJob(guard, JOBS.enrichTransactions)]);
        if ((tries.get(symbol)?.count ?? 0) >= MAX_ATTEMPTS_PER_DAY || blocked.has(provider) || !decision.allowed) return;
        await queue.enqueue({ job: JOBS.enrichTransactions, payload: { userId: '', portfolioId: '', reason: 'IMPORTED', symbols: [symbol] } });
      } catch (error) {
        logger.warn('Could not start the price history of a history symbol', { symbol, error: describeDiagnosticError(error).message });
      }
    },
  };
}
