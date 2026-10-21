import type { AlarmRunReport } from '@portfolio/shared';
import { formatDateTime } from '../../lib/format';

/** "dd-mm-yyyy, hh:mm" in the user's time zone, from epoch milliseconds. */
export const formatInstant = (ms: number): string => formatDateTime(new Date(ms).toISOString());

/** "850 ms", "2.4 s", "3 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`;
}

export type RunStatus = 'completed' | 'deferred' | 'failed' | 'no-finish' | 'running';

export const RUN_STATUS_LABELS: Readonly<Record<RunStatus, string>> = {
  completed: 'Completed',
  deferred: 'Deferred',
  failed: 'Failed',
  'no-finish': 'No finish',
  running: 'Running',
};

/** A run without a finish is `no-finish` once it is old enough to have been cut short, `running` before that. */
export function statusOf(run: AlarmRunReport): RunStatus {
  if (run.outcome !== null) return run.outcome;
  return run.unfinished ? 'no-finish' : 'running';
}

/** The retry column: "No", or "Retry 2" for the platform's second delivery attempt. */
export const retryLabel = (run: AlarmRunReport): string => (run.isRetry ? `Retry ${run.retryCount}` : 'No');

/** One line per job: "syncBroker: done", "refreshPrices: continued (2 steps, next in 1.0 s)". */
export function jobLine(job: AlarmRunReport['jobs'][number]): string {
  const details: string[] = [];
  if (job.steps > 1) details.push(`${job.steps} steps`);
  if (job.delayMs !== null && job.delayMs > 0) details.push(`next in ${formatDuration(job.delayMs)}`);
  return details.length === 0 ? `${job.job}: ${job.outcome}` : `${job.job}: ${job.outcome} (${details.join(', ')})`;
}
