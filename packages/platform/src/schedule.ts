import { JOBS, type JobName, type JobPayloads } from './job.js';

/**
 * Scheduled jobs as data. The same list drives every adapter: Terraform's EventBridge schedules (checked against
 * infra/terraform by a test), Cloudflare Cron Triggers, or a local timer. A schedule fires its job with `payload`.
 */
export interface ScheduledJob<N extends JobName = JobName> {
  /** Stable identifier, also the Terraform schedule name suffix. */
  name: string;
  job: N;
  payload: JobPayloads[N];
  /** IANA time zone of `hours`. */
  timezone: string;
  minute: number;
  /** Local hours of the day at which the job fires. */
  hours: readonly number[];
  weekdaysOnly: boolean;
}

const scheduled = <N extends JobName>(entry: ScheduledJob<N>): ScheduledJob<N> => entry;

export const SCHEDULED_JOBS = [
  scheduled({
    name: 'prices-refresh',
    job: JOBS.refreshPrices,
    payload: { trigger: 'scheduled' },
    timezone: 'Europe/Amsterdam',
    minute: 0,
    hours: [8, 13, 18, 22],
    weekdaysOnly: true,
  }),
  scheduled({
    name: 'prices-calendar',
    job: JOBS.refreshCalendar,
    payload: { trigger: 'scheduled' },
    timezone: 'Europe/Amsterdam',
    minute: 30,
    hours: [5],
    weekdaysOnly: false,
  }),
  scheduled({
    name: 'broker-sync',
    job: JOBS.syncBroker,
    payload: { all: true },
    timezone: 'Europe/Amsterdam',
    minute: 30,
    hours: [6],
    weekdaysOnly: false,
  }),
] as const satisfies readonly ScheduledJob[];

/** EventBridge Scheduler expression, e.g. `cron(0 8,13,18,22 ? * MON-FRI *)`. */
export function toAwsCron({ minute, hours, weekdaysOnly }: ScheduledJob): string {
  const [dayOfMonth, dayOfWeek] = weekdaysOnly ? ['?', 'MON-FRI'] : ['*', '?'];
  return `cron(${minute} ${hours.join(',')} ${dayOfMonth} * ${dayOfWeek} *)`;
}

/** Standard 5-field cron in the schedule's own time zone, e.g. `0 8,13,18,22 * * MON-FRI` (Cloudflare uses UTC: convert first). */
export function toUnixCron({ minute, hours, weekdaysOnly }: ScheduledJob): string {
  return `${minute} ${hours.join(',')} * * ${weekdaysOnly ? 'MON-FRI' : '*'}`;
}
