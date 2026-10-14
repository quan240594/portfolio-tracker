import { marketSymbols, type TransactionsChangedDetail } from '@portfolio/shared';
import { logger } from '../lib/logger.js';
import type { RouteContext } from '../deps.js';

/**
 * Publishes TransactionsChanged after a successful write. Failures are logged, not thrown: the write
 * already succeeded, failing the request would invite duplicate submissions, and the scheduled price
 * refresh picks up TRACKED tickers regardless.
 */
export async function publishChange(
  ctx: RouteContext,
  portfolioId: string,
  symbols: string[],
  reason: Exclude<TransactionsChangedDetail['reason'], 'IMPORTED'>,
): Promise<void> {
  // Cash (CASH.*) and custom (CUSTOM:*) symbols have no price feed, so there is nothing to enrich.
  const priced = marketSymbols(symbols);
  if (priced.length === 0) return;
  try {
    await ctx.deps.events.transactionsChanged({ userId: ctx.userId, portfolioId, symbols: priced, reason });
  } catch (err) {
    logger.error('Failed to publish TransactionsChanged', { error: err as Error, reason, portfolioId, symbols: priced });
  }
}
