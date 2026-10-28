/**
 * Earnings dates diagnostics (Settings > Diagnostics > "Earnings dates"): why a held company has, or has not, an upcoming earnings date
 * in the calendar. The daily `refreshCalendar` job leaves a record of what it did (below); this module turns that record, the stored
 * dates and the open positions into one report. Everything here is pure; the API route loads the data.
 *
 * - GET  /diagnostics/earnings-dates          the last run, the Alpha Vantage budget and, per held symbol, the next date or the reason there is none
 * - POST /diagnostics/earnings-dates/refresh  queues the calendar job once (Cloudflare deployment; once an hour, and only while the Alpha Vantage
 *                                             allowance of the day is not nearly used); 202 `{accepted: true}`, 429 `RATE_LIMITED` with `details.reason`
 *                                             (`rate-limited` or `budget-low`), 503 `NOT_CONFIGURED` (no Alpha Vantage key), 404 `NOT_AVAILABLE` where
 *                                             the deployment cannot queue it (AWS)
 *
 * Stored by the price job (`CALENDAR` partition, next to the calendar budget): `EARNINGS#LASTRUN` (every run, whatever its outcome) and
 * `EARNINGS#LASTOK` (the last run that read the provider's calendar), both `EARNINGS_RUN` items shaped like {@link EarningsRunRecord}.
 */
import { z } from 'zod';
import type { CalendarEarningsPhase, CalendarEarningsTime, CalendarEvent } from './calendar.js';

export const EARNINGS_DATES_ROUTES = {
  earningsDates: 'GET /diagnostics/earnings-dates',
  refreshEarningsDates: 'POST /diagnostics/earnings-dates/refresh',
} as const;

export const EARNINGS_RUN_ENTITY = 'EARNINGS_RUN';
export const earningsRunKeys = {
  last: { PK: 'CALENDAR', SK: 'EARNINGS#LASTRUN' },
  lastOk: { PK: 'CALENDAR', SK: 'EARNINGS#LASTOK' },
} as const;

/** How a run ended: `ok` read the provider's calendar; `skipped` never started (the Cloudflare budget guard held it back). */
export const EARNINGS_RUN_STATUSES = ['ok', 'no-provider', 'no-symbols', 'budget-exhausted', 'rate-limited', 'failed', 'skipped'] as const;
export type EarningsRunStatus = (typeof EARNINGS_RUN_STATUSES)[number];

export const EARNINGS_RUN_TRIGGERS = ['scheduled', 'manual'] as const;
export type EarningsRunTrigger = (typeof EARNINGS_RUN_TRIGGERS)[number];

/** Symbols listed in a run record; a portfolio has far fewer, the cap keeps the item small. */
export const MAX_RUN_SYMBOLS = 300;
/** A manual refresh is refused when the Alpha Vantage allowance of the day has fewer calls left than this (enrichment needs some too). */
export const MIN_CALLS_FOR_REFRESH = 3;
export const REFRESH_INTERVAL_SECONDS = 3600;

/** What one calendar run did to the earnings dates (the stored `EARNINGS_RUN` item without its keys). */
export interface EarningsRunRecord {
  /** ISO time the run started. */
  at: string;
  trigger: EarningsRunTrigger;
  status: EarningsRunStatus;
  /** The cause of a run that did not read the calendar, as a sanitized one-line message; empty for `ok`. */
  reason: string;
  /** Tracked symbols (holdings and watchlist) at the run. */
  tracked: number;
  /** Rows of the provider's calendar (every listed company). */
  rows?: number;
  /** Dates stored, and the app symbols they belong to. */
  events?: number;
  matchedSymbols?: string[];
  /** App symbols whose ticker the provider lists (on any date), and those listed under another company's name. */
  listed?: string[];
  unvouched?: string[];
}

const symbolList = z.array(z.string()).max(MAX_RUN_SYMBOLS).optional().catch(undefined);
const count = z.number().int().nonnegative();

export const earningsRunSchema = z.object({
  at: z.string(),
  trigger: z.enum(EARNINGS_RUN_TRIGGERS).catch('scheduled'),
  status: z.enum(EARNINGS_RUN_STATUSES),
  reason: z.string().catch(''),
  tracked: count.catch(0),
  rows: count.optional().catch(undefined),
  events: count.optional().catch(undefined),
  matchedSymbols: symbolList,
  listed: symbolList,
  unvouched: symbolList,
});

/** The run a stored item describes; null when there is none or it is not a record of this version. */
export function parseEarningsRun(item: Readonly<Record<string, unknown>> | undefined): EarningsRunRecord | null {
  const parsed = earningsRunSchema.safeParse(item);
  if (!parsed.success) return null;
  const { rows, events, matchedSymbols, listed, unvouched, ...run } = parsed.data;
  return { ...run, ...(rows === undefined ? {} : { rows }), ...(events === undefined ? {} : { events }), ...(matchedSymbols ? { matchedSymbols } : {}), ...(listed ? { listed } : {}), ...(unvouched ? { unvouched } : {}) };
}

// --- The report ---------------------------------------------------------------------------------------

export const EARNINGS_NO_DATE_REASONS = ['not-applicable', 'not-tracked', 'never-run', 'since-bought', 'no-provider', 'budget', 'rate-limited', 'failed', 'skipped', 'name-mismatch', 'no-upcoming-date', 'not-listed'] as const;
export type EarningsNoDateReason = (typeof EARNINGS_NO_DATE_REASONS)[number];

export interface HeldEarningsDate {
  symbol: string;
  name: string;
  /** The next date as the calendar shows it; null when there is none. */
  next: { date: string; source: CalendarEarningsPhase; timeOfDay: CalendarEarningsTime } | null;
  /** Why there is no date (null when there is one). */
  reasonCode: EarningsNoDateReason | null;
  reason: string | null;
}

export interface EarningsRunReport {
  at: string;
  trigger: EarningsRunTrigger;
  status: EarningsRunStatus;
  reason: string;
  tracked: number;
  rows: number | null;
  events: number | null;
  /** Held symbols among the ones the run stored a date for; null when the run did not say. */
  matchedHeld: number | null;
}

/** The Alpha Vantage allowance of the UTC day: every call of the app (profiles, estimates, the calendar) counts. */
export interface ProviderBudgetReport {
  provider: 'Alpha Vantage';
  day: string;
  used: number;
  limit: number;
  remaining: number;
  /** Calls the daily refresh itself may use, and has used today. */
  calendarUsed: number;
  calendarLimit: number;
}

export interface RefreshReport {
  /** Whether the "Refresh earnings dates now" button would queue the job right now. */
  available: boolean;
  /** Why not (null when available). */
  reason: string | null;
  /** When it may be asked again (rate limit), ISO time. */
  nextAllowedAt: string | null;
}

export interface EarningsDatesResponse {
  asOf: string;
  today: string;
  /** The last attempt, whatever its outcome, and the last one that read the provider's calendar; null before the first run. */
  lastRun: EarningsRunReport | null;
  lastSuccess: EarningsRunReport | null;
  budget: ProviderBudgetReport | null;
  refresh: RefreshReport;
  held: number;
  withDate: number;
  symbols: HeldEarningsDate[];
}

const reportOf = (run: EarningsRunRecord | null, held: ReadonlySet<string>): EarningsRunReport | null =>
  run === null
    ? null
    : {
        at: run.at,
        trigger: run.trigger,
        status: run.status,
        reason: run.reason,
        tracked: run.tracked,
        rows: run.rows ?? null,
        events: run.events ?? null,
        matchedHeld: run.matchedSymbols === undefined ? null : run.matchedSymbols.filter((symbol) => held.has(symbol)).length,
      };

const CRYPTO = /^[A-Z0-9]+-[A-Z]{3}$/;
const day = (iso: string): string => iso.slice(0, 10);

interface WhyInput {
  symbol: string;
  name: string;
  /** `undefined`: not tracked; null: tracked, since an unknown time. */
  trackedAt: string | null | undefined;
  run: EarningsRunRecord | null;
  lastOk: EarningsRunRecord | null;
}

type Why = { code: EarningsNoDateReason; text: string };

/** Why the last attempt did not read the provider's calendar. */
function failureWhy(run: EarningsRunRecord): Why {
  const when = day(run.at);
  switch (run.status) {
    case 'rate-limited':
      return { code: 'rate-limited', text: `The Alpha Vantage rate limit was reached on ${when}: ${run.reason}. Nothing was read.` };
    case 'budget-exhausted':
      return { code: 'budget', text: `The daily Alpha Vantage allowance for the calendar was already used on ${when}, so the job did not call the provider.` };
    case 'no-provider':
      return { code: 'no-provider', text: `No Alpha Vantage key is set on this deployment, so earnings dates are not looked up (last run ${when}).` };
    case 'no-symbols':
      return { code: 'not-tracked', text: `The last run (${when}) found no tracked symbol that has a US ticker to look up.` };
    case 'skipped':
      return { code: 'skipped', text: `The run of ${when} did not start: ${run.reason}` };
    default:
      return { code: 'failed', text: `The provider call failed on ${when}: ${run.reason || 'no detail was recorded'}.` };
  }
}

/** The provider answered (`run`): why it has no upcoming date for the symbol. */
function answerWhy({ symbol, name }: WhyInput, run: EarningsRunRecord): Why {
  const when = day(run.at);
  if (run.unvouched?.includes(symbol)) return { code: 'name-mismatch', text: `The provider lists the ticker, but for a company whose name does not match "${name}", so its date was not taken (${when}).` };
  if (run.listed?.includes(symbol)) return { code: 'no-upcoming-date', text: `The provider lists it, but with no upcoming date (${when}).` };
  const rows = run.rows === undefined ? 'its calendar' : `its calendar of ${run.rows} rows`;
  return { code: 'not-listed', text: `Not in the provider's calendar: ${rows} (${when}) has no row for ${symbol}.` };
}

/** Why a held symbol has no upcoming earnings date. */
export function whyNoEarningsDate(input: WhyInput): Why {
  const { symbol, trackedAt, run, lastOk } = input;
  if (CRYPTO.test(symbol)) return { code: 'not-applicable', text: 'Crypto has no earnings reports.' };
  if (trackedAt === undefined) return { code: 'not-tracked', text: 'Not tracked yet: the calendar job only looks up tracked symbols, and this one has not been registered (it is registered when the transaction is saved or the price history is fetched).' };
  if (run === null) return { code: 'never-run', text: 'The calendar job has not run yet (it runs daily at 05:30 Amsterdam time).' };
  if (trackedAt !== null && trackedAt > run.at) return { code: 'since-bought', text: `The calendar job has not run since you bought it (added ${day(trackedAt)}, last run ${day(run.at)}).` };
  if (run.status === 'ok') return answerWhy(input, run);
  // The last attempt failed: an earlier answer that already covered the symbol still says whether the provider knew it.
  const earlier = lastOk !== null && (trackedAt === null || trackedAt <= lastOk.at) ? lastOk : null;
  if (earlier === null) return failureWhy(run);
  const answer = answerWhy(input, earlier);
  return { code: answer.code, text: `${answer.text} The latest attempt did not read the calendar either: ${failureWhy(run).text}` };
}

export interface EarningsDatesInput {
  now: Date;
  /** The open positions of the market (no cash or custom assets), with their display names. */
  held: readonly { symbol: string; name: string }[];
  /** `createdAt` of the tracked-ticker item of each tracked symbol (null: tracked, time unknown). */
  tracked: ReadonlyMap<string, string | null>;
  /** The next event per symbol as the calendar shows it (see `nextEarningsEvents`). */
  next: ReadonlyMap<string, CalendarEvent>;
  run: EarningsRunRecord | null;
  lastOk: EarningsRunRecord | null;
  budget: ProviderBudgetReport | null;
  refresh: RefreshReport;
}

/** The report: symbols without a date first (by symbol), then the ones with the earliest date first. */
export function buildEarningsDatesReport(input: EarningsDatesInput): EarningsDatesResponse {
  const { now, run, lastOk } = input;
  const symbols = input.held.map(({ symbol, name }): HeldEarningsDate => {
    const event = input.next.get(symbol);
    if (event) return { symbol, name, next: { date: event.date, source: event.earningsPhase ?? 'scheduled', timeOfDay: event.timeOfDay ?? 'unknown' }, reasonCode: null, reason: null };
    const why = whyNoEarningsDate({ symbol, name, trackedAt: input.tracked.get(symbol), run, lastOk });
    return { symbol, name, next: null, reasonCode: why.code, reason: why.text };
  });
  symbols.sort((a, b) => {
    if (a.next === null && b.next !== null) return -1;
    if (a.next !== null && b.next === null) return 1;
    return (a.next?.date ?? '').localeCompare(b.next?.date ?? '') || a.symbol.localeCompare(b.symbol);
  });
  const heldSymbols = new Set(input.held.map((entry) => entry.symbol));
  return {
    asOf: now.toISOString(),
    today: now.toISOString().slice(0, 10),
    lastRun: reportOf(run, heldSymbols),
    lastSuccess: reportOf(lastOk, heldSymbols),
    budget: input.budget,
    refresh: input.refresh,
    held: symbols.length,
    withDate: symbols.filter((entry) => entry.next !== null).length,
    symbols,
  };
}

const iso = z.string().min(1);
const runReport = z.object({
  at: iso,
  trigger: z.enum(EARNINGS_RUN_TRIGGERS),
  status: z.enum(EARNINGS_RUN_STATUSES),
  reason: z.string(),
  tracked: count,
  rows: count.nullable(),
  events: count.nullable(),
  matchedHeld: count.nullable(),
});

/** Validates the response of `GET /diagnostics/earnings-dates` (the web client parses it with this). */
export const earningsDatesSchema = z.object({
  asOf: iso,
  today: iso,
  lastRun: runReport.nullable(),
  lastSuccess: runReport.nullable(),
  budget: z.object({ provider: z.literal('Alpha Vantage'), day: iso, used: count, limit: count, remaining: count, calendarUsed: count, calendarLimit: count }).nullable(),
  refresh: z.object({ available: z.boolean(), reason: z.string().nullable(), nextAllowedAt: z.string().nullable() }),
  held: count,
  withDate: count,
  symbols: z.array(
    z.object({
      symbol: z.string(),
      name: z.string(),
      next: z.object({ date: iso, source: z.enum(['reported', 'scheduled', 'projected']), timeOfDay: z.enum(['BMO', 'AMC', 'unknown']) }).nullable(),
      reasonCode: z.enum(EARNINGS_NO_DATE_REASONS).nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

export type GetEarningsDatesResponse = EarningsDatesResponse;
export type RefreshEarningsDatesResponse = { accepted: true };

/** The reason line of a refusal of the refresh route, and the code the web client keys on. */
export const REFRESH_REFUSALS = ['rate-limited', 'budget-low', 'not-configured'] as const;
export type RefreshRefusal = (typeof REFRESH_REFUSALS)[number];
