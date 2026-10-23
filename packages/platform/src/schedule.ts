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
  /** Minute(s) of the hour at which the job fires. */
  minute: number | readonly number[];
  /** Local hours of the day at which the job fires. */
  hours: readonly number[];
  weekdaysOnly: boolean;
  /** Only the Cloudflare adapter keeps this schedule: there is no EventBridge schedule (nor Terraform resource) for it. */
  cloudflareOnly?: true;
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
  // Dividends are booked during the day: three more weekday syncs (12:30, 18:30, 22:30) record a payment within hours instead of the next
  // morning. An incremental run reads one page per history, re-reads the 7-day overlap and writes only new or changed transactions.
  scheduled({
    name: 'broker-sync-intraday',
    job: JOBS.syncBroker,
    payload: { all: true },
    timezone: 'Europe/Amsterdam',
    minute: 30,
    hours: [12, 18, 22],
    weekdaysOnly: true,
    cloudflareOnly: true,
  }),
  // Pushes the dividend notifications that are due (the morning run also covers what quiet hours held back overnight).
  scheduled({
    name: 'notify-dividends',
    job: JOBS.notifyDividends,
    payload: { trigger: 'scheduled' },
    timezone: 'Europe/Amsterdam',
    minute: 0,
    hours: [9],
    weekdaysOnly: false,
    cloudflareOnly: true,
  }),
  // Weekdays 07:00-21:45 every 15 minutes, plus one run at 22:05 (after the US close): 61 runs a day. Each costs one subrequest
  // per connected account and one batched write of about one row per held symbol, see docs/architecture.md.
  scheduled({
    name: 't212-quotes',
    job: JOBS.refreshT212Quotes,
    payload: { trigger: 'scheduled' },
    timezone: 'Europe/Amsterdam',
    minute: [0, 15, 30, 45],
    hours: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    weekdaysOnly: true,
    cloudflareOnly: true,
  }),
  scheduled({
    name: 't212-quotes-close',
    job: JOBS.refreshT212Quotes,
    payload: { trigger: 'scheduled' },
    timezone: 'Europe/Amsterdam',
    minute: 5,
    hours: [22],
    weekdaysOnly: true,
    cloudflareOnly: true,
  }),
  // US results arrive after the close (22:00 Amsterdam and later): look every 30 minutes from 13:00 to 23:30 on weekdays, and once at 07:30 for
  // what came in overnight and for the symbols without a calendar date. Each look costs one SEC request per candidate symbol.
  scheduled({
    name: 'earnings-watch',
    job: JOBS.watchEarnings,
    payload: { trigger: 'scheduled' },
    timezone: 'Europe/Amsterdam',
    minute: [0, 30],
    hours: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    weekdaysOnly: true,
    cloudflareOnly: true,
  }),
  scheduled({
    name: 'earnings-watch-morning',
    job: JOBS.watchEarnings,
    payload: { trigger: 'scheduled' },
    timezone: 'Europe/Amsterdam',
    minute: 30,
    hours: [7],
    weekdaysOnly: false,
    cloudflareOnly: true,
  }),
] as const satisfies readonly ScheduledJob[];

const minutesOf = ({ minute }: ScheduledJob): string => (typeof minute === 'number' ? String(minute) : minute.join(','));

/** EventBridge Scheduler expression, e.g. `cron(0 8,13,18,22 ? * MON-FRI *)`. */
export function toAwsCron(schedule: ScheduledJob): string {
  const { hours, weekdaysOnly } = schedule;
  const [dayOfMonth, dayOfWeek] = weekdaysOnly ? ['?', 'MON-FRI'] : ['*', '?'];
  return `cron(${minutesOf(schedule)} ${hours.join(',')} ${dayOfMonth} * ${dayOfWeek} *)`;
}

/** Standard 5-field cron in the schedule's own time zone, e.g. `0 8,13,18,22 * * MON-FRI` (Cloudflare uses UTC: convert first). */
export function toUnixCron(schedule: ScheduledJob): string {
  const { hours, weekdaysOnly } = schedule;
  return `${minutesOf(schedule)} ${hours.join(',')} * * ${weekdaysOnly ? 'MON-FRI' : '*'}`;
}
