import { EARNINGS_KEEP_QUARTERS } from '@portfolio/shared';
import type { EarningsSummary } from '@portfolio/shared';
import { withPrevious } from './derive.js';
import type { EarningsRepository } from './repository.js';

/**
 * Stores a summary, recomputes the quarter-over-quarter figures of the next newer stored summary against it (the backfill stores the newest
 * quarter first, so its predecessor arrives later; recomputing is idempotent) and prunes the symbol to the newest quarters.
 */
export async function storeSummary(repo: EarningsRepository, summary: EarningsSummary): Promise<void> {
  await repo.putSummary(summary);
  const stored = await repo.latest(summary.symbol, EARNINGS_KEEP_QUARTERS + 4);
  const index = stored.findIndex((entry) => entry.reportDate === summary.reportDate);
  const newer = index > 0 ? stored[index - 1] : undefined;
  if (newer !== undefined) await repo.putSummary(withPrevious(newer, summary));
  await repo.prune(summary.symbol);
}
