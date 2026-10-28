import { paginate, type BrokerSyncEvent, type TransactionsChangedDetail } from '@portfolio/shared';

/**
 * Background jobs. Every asynchronous piece of work (CSV ingestion, broker sync, price enrichment, scheduled
 * refreshes) is a named job with a JSON payload. Delivery is at-least-once, so handlers must be idempotent.
 */
export const JOBS = {
  importUploaded: 'importUploaded',
  syncBroker: 'syncBroker',
  enrichTransactions: 'enrichTransactions',
  refreshPrices: 'refreshPrices',
  refreshCalendar: 'refreshCalendar',
  refreshT212Quotes: 'refreshT212Quotes',
  notifyDividends: 'notifyDividends',
  watchEarnings: 'watchEarnings',
  fetchEarningsSummary: 'fetchEarningsSummary',
  backfillEarnings: 'backfillEarnings',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface JobPayloads {
  /** A CSV upload is complete: process the import `importId` of `userId`. */
  importUploaded: { userId: string; importId: string };
  /** Sync one connected portfolio (`{userId, portfolioId, full?}`) or every connected portfolio (`{all: true}`). */
  syncBroker: BrokerSyncEvent;
  /** Transactions were created/deleted/imported: enrich (profile, history) the newly tracked symbols. */
  enrichTransactions: TransactionsChangedDetail;
  refreshPrices: { trigger: 'scheduled' };
  /** `scheduled`: the daily run. `manual`: the owner pressed "Refresh earnings dates now" (Diagnostics): it is not held to the calendar's own one-call-a-day budget, only to the provider's daily quota. */
  refreshCalendar: { trigger: 'scheduled' | 'manual' };
  /** Refresh the quotes of the positions held at Trading 212 (`scheduled`; `close` at the 22:05 slot, which also keeps the quotes as end-of-day rows; `sync` right after a successful sync); `userId` limits it to one user. */
  refreshT212Quotes: { trigger: 'scheduled' | 'sync' | 'close'; userId?: string };
  /** Send the dividend push notifications that are due (`scheduled` for everyone, `sync` after a broker sync for `userId`). */
  notifyDividends: { trigger: 'scheduled' | 'sync'; userId?: string };
  /**
   * Look for newly published quarterly results of the held companies (`scheduled`), or re-check one symbol the owner asked for (`manual`, with `symbol`).
   * Cheap: one SEC request per candidate symbol; a found release becomes a `fetchEarningsSummary` job.
   */
  watchEarnings: { trigger: 'scheduled' | 'manual'; symbol?: string };
  /** Read one release (an SEC filing of `symbol`), extract and verify its figures and store the summary. */
  fetchEarningsSummary: { symbol: string; cik: string; accession: string; form: '8-K' | '6-K'; filingDate: string; primaryDocument: string; origin: 'live' | 'backfill' };
  /**
   * Read the most recent quarterly releases of every eligible held company, newest first across all companies, within the daily Workers AI
   * allowance (`scheduled`: every 15 minutes, a one-row no-op once complete or while waiting; `manual`: the owner pressed "Fetch all now").
   */
  backfillEarnings: { trigger: 'scheduled' | 'manual' };
}

/**
 * One step of a job. A job that cannot finish inside one invocation (Cloudflare Workers: 10 ms CPU, 50 subrequests;
 * Lambda: 15 minutes) returns `{ done: false, next }`: `next` is an opaque continuation (a JSON string the handler
 * understands, e.g. the page cursor and the work done so far) and the adapter calls the handler again with it, after
 * `delayMs` when given. A step must be idempotent: after a crash the adapter re-delivers the same invocation.
 */
export type JobStep<R = unknown> = { done: true; result: R } | { done: false; next: string; delayMs?: number };

export interface JobInvocation<P = unknown> {
  payload: P;
  /** The `next` of the previous step; undefined for the first one. */
  cursor?: string;
}

export type JobHandler<P = unknown, R = unknown> = (invocation: JobInvocation<P>) => Promise<JobStep<R>>;

/** Handlers by job name. */
export type JobRegistry = { [N in JobName]?: JobHandler<JobPayloads[N]> };

export interface JobMessage<N extends JobName = JobName> {
  job: N;
  payload: JobPayloads[N];
  /** Do not deliver before this many milliseconds have passed (best effort). */
  delayMs?: number;
}

/** Starts jobs without waiting for them. */
export interface JobQueue {
  enqueue<N extends JobName>(message: JobMessage<N>): Promise<void>;
}

export const MAX_JOB_STEPS = 10_000;

export interface RunOptions {
  /** Safety net against a handler that never finishes. */
  maxSteps?: number;
  /** Used to honour `delayMs` between steps. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Called with every step, e.g. to log progress. */
  onStep?: (step: JobStep) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs a job's steps back to back in the current invocation and resolves its result. This is what an adapter with
 * no per-invocation budget does (AWS Lambda: exactly the behaviour before steps existed); budgeted adapters instead
 * persist `next` and re-enqueue it.
 */
export async function runToCompletion<P, R>(handler: JobHandler<P, R>, payload: P, options: RunOptions = {}): Promise<R> {
  const { maxSteps = MAX_JOB_STEPS, sleep = defaultSleep, onStep } = options;
  const steps = paginate<JobStep<R>, string>(async (cursor) => {
    const step = await handler({ payload, cursor });
    onStep?.(step);
    if (!step.done && step.delayMs) await sleep(step.delayMs);
    return { page: step, next: step.done ? undefined : step.next };
  });
  let count = 0;
  let last: JobStep<R> | undefined;
  for await (const step of steps) {
    last = step;
    if (!step.done && ++count >= maxSteps) throw new Error(`Job did not finish within ${maxSteps} steps`);
  }
  // The pages end with the done step.
  return (last as { done: true; result: R }).result;
}
