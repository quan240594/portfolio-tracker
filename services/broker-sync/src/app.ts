import { logger, runToCompletion, type JobHandler, type JobStep } from '@portfolio/platform';
import { brokerSyncEventSchema } from '@portfolio/shared';
import { syncAllJob, syncJob, type SyncDeps, type SyncResult } from './sync.js';

export interface HandlerResult {
  results: SyncResult[];
}

const wrap = (step: JobStep<SyncResult | SyncResult[]>): JobStep<HandlerResult> =>
  step.done ? { done: true, result: { results: [step.result].flat() } } : step;

/**
 * The `syncBroker` job: `{"all":true}` syncs every connected portfolio (EventBridge Scheduler), `{userId, portfolioId,
 * full?}` one (the API). Resumable: see `syncJob`. Sync failures are recorded in the state item and reported in the
 * result, not thrown, so asynchronous invocations are not retried blindly; an invalid event is thrown.
 */
export function brokerSyncJob(getDeps: () => SyncDeps): JobHandler<unknown, HandlerResult> {
  return async ({ payload, cursor }) => {
    const parsed = brokerSyncEventSchema.safeParse(payload);
    if (!parsed.success) {
      logger.error('Ignoring invalid sync event');
      throw new Error('Invalid sync event');
    }
    const deps = getDeps();
    if ('all' in parsed.data) return wrap(await syncAllJob(deps)({ payload: undefined, cursor }));
    const { userId, portfolioId, full } = parsed.data;
    return wrap(await syncJob(deps)({ payload: { userId, portfolioId, full }, cursor }));
  };
}

/**
 * Lambda entry point: the event is the bare job payload and the whole job runs inside the invocation, one step after
 * the other (a Lambda has minutes, not milliseconds, so there is nothing to persist between steps).
 */
export function createHandler(getDeps: () => SyncDeps) {
  return (event: unknown): Promise<HandlerResult> => {
    let deps: SyncDeps | undefined;
    // The steps share the dependencies of the invocation.
    return runToCompletion(brokerSyncJob(() => (deps ??= getDeps())), event);
  };
}
