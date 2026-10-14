import type { TransactionsChangedDetail } from '@portfolio/shared';
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
  try {
    await ctx.deps.events.transactionsChanged({ userId: ctx.userId, portfolioId, symbols, reason });
  } catch (err) {
    logger.error('Failed to publish TransactionsChanged', { error: err as Error, reason, portfolioId, symbols });
  }
}
