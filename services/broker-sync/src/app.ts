import { brokerSyncEventSchema } from '@portfolio/shared';
import { logger } from './logger.js';
import { runAll, runSync, type SyncDeps, type SyncResult } from './sync.js';

export interface HandlerResult {
  results: SyncResult[];
}

/**
 * Lambda entry point. Invoked by EventBridge Scheduler with `{"all":true}` (every connected portfolio) and by the
 * API with `{userId, portfolioId, full?}`. Sync failures are recorded in the state item and reported in the result,
 * not thrown, so asynchronous invocations are not retried blindly.
 */
export function createHandler(getDeps: () => SyncDeps) {
  return async (event: unknown): Promise<HandlerResult> => {
    const parsed = brokerSyncEventSchema.safeParse(event);
    if (!parsed.success) {
      logger.error('Ignoring invalid sync event');
      throw new Error('Invalid sync event');
    }
    const deps = getDeps();
    if ('all' in parsed.data) return { results: await runAll(deps) };
    const { userId, portfolioId, full } = parsed.data;
    return { results: [await runSync(deps, { userId, portfolioId, full })] };
  };
}
