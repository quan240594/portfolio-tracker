import type { UsageState } from '@portfolio/shared';
import type { JobName } from '../job.js';
import type { BudgetGuard } from './guard.js';

/** How busy the budget may be while a job still runs: `ok` = only below 60 %, `warn` = below 80 % (blocked stops everything). */
export type JobCeiling = 'ok' | 'warn';

/**
 * Priority of every background job. Non-essential work gives way first: it stops at the warning threshold so the
 * budget that is left serves the owner's requests and the jobs that keep the data correct.
 */
export const JOB_CEILINGS: Readonly<Record<JobName, JobCeiling>> = {
  /** Price refresh is a convenience: it runs only below 60 %. */
  refreshPrices: 'ok',
  /** Calendar refresh is a convenience too. */
  refreshCalendar: 'ok',
  /**
   * The Trading 212 quote refresh is the only live price source without market-data keys. It costs one subrequest and about
   * one row per held symbol per run, so it may run until the budget is blocked (80 %); below that it is cheaper than the
   * requests it saves the owner from waiting on.
   */
  refreshT212Quotes: 'warn',
  /** The Trading 212 sync keeps the holdings right: it runs below 80 %. */
  syncBroker: 'warn',
  /** Enrichment follows a change the owner just made. */
  enrichTransactions: 'warn',
  /** An import the owner just started. */
  importUploaded: 'warn',
  /** A push costs one subrequest and a few rows; it runs until the budget is blocked (80 %) and is dropped, not deferred, above it: the next run sends what is due. */
  notifyDividends: 'warn',
  /** Looking for a release is a convenience (one cheap request per candidate): only below 60 %. */
  watchEarnings: 'ok',
  /** Reading a release costs a few requests and rows plus Workers AI neurons (which have their own cap): only below 60 %; a skipped run is simply tried again by the next watch. */
  fetchEarningsSummary: 'ok',
  /** The backfill is a convenience that must never crowd out the owner's requests: only below 60 %; a skipped run is simply tried again 15 minutes later. */
  backfillEarnings: 'ok',
};

/** A job this table does not know is treated as non-essential. */
const UNKNOWN_JOB_CEILING: JobCeiling = 'ok';

export interface JobDecision {
  allowed: boolean;
  state: UsageState;
  reason: 'within-budget' | 'deferred-by-priority' | 'blocked' | 'store-unavailable';
}

/**
 * May the background job `jobName` run now? Call it first thing in the alarm/job handler; a denied job is retried by its own schedule.
 * `ceiling` replaces the job's own ceiling for one run (an owner-requested run of a convenience job may use the `warn` band).
 */
export async function guardJob(guard: BudgetGuard, jobName: string, ceiling?: JobCeiling): Promise<JobDecision> {
  const decision = await guard.check('job');
  const { state } = decision;
  if (state === 'unavailable') return { allowed: false, state, reason: 'store-unavailable' };
  if (!decision.allowed) return { allowed: false, state, reason: 'blocked' };
  const limit = ceiling ?? (Object.hasOwn(JOB_CEILINGS, jobName) ? JOB_CEILINGS[jobName as JobName] : UNKNOWN_JOB_CEILING);
  if (state === 'warn' && limit === 'ok') return { allowed: false, state, reason: 'deferred-by-priority' };
  return { allowed: true, state, reason: 'within-budget' };
}
