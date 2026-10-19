/**
 * A small cron evaluator for the unix 5-field expressions of `toUnixCron` (`minute hour day-of-month month day-of-week`).
 * Supported per field: `*`, numbers, lists (`1,5`), ranges (`1-5`), steps (`*\/15`, `1-10/2`); month and weekday names
 * (`JAN`, `MON-FRI`). Weekday 0 and 7 are Sunday. When both day fields are restricted a day matches if EITHER does
 * (classic cron), otherwise both must match.
 */
export interface CronSpec {
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  /** The day-of-month / day-of-week field is `*` (unrestricted). */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** Calendar days searched before giving up (an expression such as `0 0 31 2 *` never fires). */
const MAX_SEARCH_DAYS = 366 * 8;

function toNumber(token: string, names: readonly string[], offset: number): number {
  const index = names.indexOf(token.toUpperCase());
  if (index >= 0) return index + offset;
  if (!/^\d{1,2}$/.test(token)) throw new Error(`Invalid cron value "${token}"`);
  return Number(token);
}

interface RangeEndContext {
  low: number;
  max: number;
  names: readonly string[];
  nameOffset: number;
}

/** The end of `from[-to][/step]`: a lone number with a step (`5/10`) runs to the end of the field, without one it is a single value. */
function rangeEnd(to: string | undefined, step: string | undefined, { low, max, names, nameOffset }: RangeEndContext): number {
  if (to !== undefined) return toNumber(to, names, nameOffset);
  return step === undefined ? low : max;
}

function parseField(text: string, min: number, max: number, names: readonly string[] = [], nameOffset = 0): number[] {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', step, ...extra] = part.split('/');
    if (extra.length > 0 || part === '') throw new Error(`Invalid cron field "${text}"`);
    const stride = step === undefined ? 1 : Number(step);
    if (!Number.isInteger(stride) || stride < 1) throw new Error(`Invalid cron step in "${text}"`);
    const [from = '', to, ...more] = range.split('-');
    if (more.length > 0) throw new Error(`Invalid cron range in "${text}"`);
    let low = min;
    let high = max;
    if (from !== '*') {
      low = toNumber(from, names, nameOffset);
      high = rangeEnd(to, step, { low, max, names, nameOffset });
    }
    if (low < min || high > max || low > high) throw new Error(`Cron value out of range in "${text}" (${min}-${max})`);
    for (let value = low; value <= high; value += stride) values.add(value);
  }
  return [...values];
}

export function parseCron(cron: string): CronSpec {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`A cron expression needs 5 fields, got ${fields.length}: "${cron}"`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  return {
    minutes: [...parseField(minute, 0, 59)].sort((a, b) => a - b),
    hours: [...parseField(hour, 0, 23)].sort((a, b) => a - b),
    daysOfMonth: new Set(parseField(dayOfMonth, 1, 31)),
    months: new Set(parseField(month, 1, 12, MONTHS, 1)),
    daysOfWeek: new Set(parseField(dayOfWeek, 0, 7, WEEKDAYS, 0).map((day) => day % 7)),
    anyDayOfMonth: dayOfMonth.startsWith('*'),
    anyDayOfWeek: dayOfWeek.startsWith('*'),
  };
}

function dayMatches(spec: CronSpec, month: number, dayOfMonth: number, dayOfWeek: number): boolean {
  if (!spec.months.has(month)) return false;
  const domOk = spec.daysOfMonth.has(dayOfMonth);
  const dowOk = spec.daysOfWeek.has(dayOfWeek);
  return spec.anyDayOfMonth || spec.anyDayOfWeek ? domOk && dowOk : domOk || dowOk;
}

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localTime(ms: number, timeZone: string): LocalTime {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(ms).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute! };
}

const wallClockMs = (t: LocalTime): number => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute);

const DAY_MS = 86_400_000;

/**
 * The first instant at which the clock of `timeZone` shows `wall`, or undefined when it never does (a daylight saving
 * gap). The UTC offsets a day before and a day after bracket any transition, so both candidates are tried.
 */
function instantOf(wall: LocalTime, timeZone: string): number | undefined {
  const target = wallClockMs(wall);
  const offsets = new Set([target - DAY_MS, target + DAY_MS].map((probe) => wallClockMs(localTime(probe, timeZone)) - probe));
  const instants = [...offsets].map((offset) => target - offset).filter((instant) => wallClockMs(localTime(instant, timeZone)) === target);
  return instants.length === 0 ? undefined : Math.min(...instants);
}

/**
 * The first instant strictly after `from` (epoch milliseconds, minute resolution) at which `cron` fires, with the
 * cron's hours and days read on the clock of `timeZone` (an IANA name; default UTC, which is what Cloudflare Cron
 * Triggers use). Daylight saving is honoured: a time that does not exist that day is skipped, an ambiguous one fires first.
 */
export function nextCronRun(cron: string, from: Date | number, timeZone = 'UTC'): number {
  const spec = parseCron(cron);
  const fromMs = typeof from === 'number' ? from : from.getTime();
  const start = localTime(fromMs, timeZone);
  for (let offset = 0; offset < MAX_SEARCH_DAYS; offset++) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const [year, month, dayOfMonth] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    if (!dayMatches(spec, month, dayOfMonth, day.getUTCDay())) continue;
    const candidates = spec.hours
      .flatMap((hour) => spec.minutes.map((minute) => instantOf({ year, month, day: dayOfMonth, hour, minute }, timeZone)))
      .filter((instant): instant is number => instant !== undefined && instant > fromMs);
    if (candidates.length > 0) return Math.min(...candidates);
  }
  throw new Error(`The cron expression "${cron}" does not fire within ${MAX_SEARCH_DAYS} days`);
}
