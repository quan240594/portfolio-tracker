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
  /** The Trading 212 sync keeps the holdings right: it runs below 80 %. */
  syncBroker: 'warn',
  /** Enrichment follows a change the owner just made. */
  enrichTransactions: 'warn',
  /** An import the owner just started. */
  importUploaded: 'warn',
};

/** A job this table does not know is treated as non-essential. */
const UNKNOWN_JOB_CEILING: JobCeiling = 'ok';

export interface JobDecision {
  allowed: boolean;
  state: UsageState;
  reason: 'within-budget' | 'deferred-by-priority' | 'blocked' | 'store-unavailable';
}

/** May the background job `jobName` run now? Call it first thing in the alarm/job handler; a denied job is retried by its own schedule. */
export async function guardJob(guard: BudgetGuard, jobName: string): Promise<JobDecision> {
  const decision = await guard.check('job');
  const { state } = decision;
  if (state === 'unavailable') return { allowed: false, state, reason: 'store-unavailable' };
  if (!decision.allowed) return { allowed: false, state, reason: 'blocked' };
  const ceiling = Object.hasOwn(JOB_CEILINGS, jobName) ? JOB_CEILINGS[jobName as JobName] : UNKNOWN_JOB_CEILING;
  if (state === 'warn' && ceiling === 'ok') return { allowed: false, state, reason: 'deferred-by-priority' };
  return { allowed: true, state, reason: 'within-budget' };
}
