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
import { CALENDAR_EARNINGS_TIMES, CALENDAR_STATUSES, type CalendarEarningsPhase, type CalendarEarningsTime, type CalendarEvent, type CalendarStatus } from './calendar.js';

export const EARNINGS_DATES_ROUTES = {
  earningsDates: 'GET /diagnostics/earnings-dates',
  refreshEarningsDates: 'POST /diagnostics/earnings-dates/refresh',
} as const;

export const EARNINGS_RUN_ENTITY = 'EARNINGS_RUN';
export const earningsRunKeys = {
  last: { PK: 'CALENDAR', SK: 'EARNINGS#LASTRUN' },
  lastOk: { PK: 'CALENDAR', SK: 'EARNINGS#LASTOK' },
} as const;

/**
 * How a run ended: `ok` read a provider's calendar; `provider-limited` got an answer far too small to be the real calendar (a free key
 * without access); `skipped` never started (the Cloudflare budget guard held it back).
 */
export const EARNINGS_RUN_STATUSES = ['ok', 'provider-limited', 'no-provider', 'no-symbols', 'budget-exhausted', 'rate-limited', 'failed', 'skipped'] as const;
export type EarningsRunStatus = (typeof EARNINGS_RUN_STATUSES)[number];

/** The sources of earnings dates, and how the attempt on one of them ended (`no-key`: its secret is not set). */
export const EARNINGS_SOURCES = ['alphavantage', 'finnhub'] as const;
export type EarningsSourceName = (typeof EARNINGS_SOURCES)[number];
export const EARNINGS_SOURCE_STATUSES = ['ok', 'provider-limited', 'no-key', 'budget-exhausted', 'rate-limited', 'refused', 'failed'] as const;
export type EarningsSourceStatus = (typeof EARNINGS_SOURCE_STATUSES)[number];

/** A calendar with fewer rows than this for the 12-month horizon is not the real one (the real one lists thousands of companies). */
export const MIN_CALENDAR_ROWS = 100;

export const SOURCE_LABELS: Readonly<Record<EarningsSourceName, string>> = { alphavantage: 'Alpha Vantage', finnhub: 'Finnhub' };

/**
 * How one company's lookup ended (sources that are asked per company, Finnhub): `date` (an upcoming date), `none` (the source answered and
 * knows no date), `failed`, `rate-limited` or `refused` (the call was made and ended so) and `pending` (not asked in this run).
 */
export const EARNINGS_LOOKUP_RESULTS = ['date', 'none', 'failed', 'rate-limited', 'refused', 'pending'] as const;
export type EarningsLookupResult = (typeof EARNINGS_LOOKUP_RESULTS)[number];

/** The lookup of one held company at a source that is asked company by company. */
export interface EarningsCompanyCheck {
  symbol: string;
  result: EarningsLookupResult;
  /** The upcoming date the source gave (`date`). */
  date?: string;
  /** Sanitized one-line cause (`failed`, `rate-limited`, `refused`). */
  reason?: string;
}

/** What one source did in a run. */
export interface EarningsSourceRun {
  source: EarningsSourceName;
  status: EarningsSourceStatus;
  /** Sanitized one-line cause when the status is not `ok`; for a source asked company by company, the last error. */
  reason: string;
  rows?: number;
  events?: number;
  matchedSymbols?: string[];
  /** Held companies the source was to be asked about, and how many of them it gave an upcoming date for (sources asked company by company). */
  companies?: number;
  withDate?: number;
  /** One entry per company (most urgent first). */
  checks?: EarningsCompanyCheck[];
}

/** Two sources listed different dates for one company in the same run; `kept` was stored, `dropped` was not. */
export interface EarningsConflict {
  symbol: string;
  kept: { source: EarningsSourceName; date: string };
  dropped: { source: EarningsSourceName; date: string };
}

/** Conflicts listed in a run record. */
export const MAX_RUN_CONFLICTS = 50;

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
  /** One entry per source the run tried (absent in records written before there were several sources). */
  sources?: EarningsSourceRun[];
  conflicts?: EarningsConflict[];
}

/** A field that falls back to `fallback` instead of failing the whole record when it is missing or malformed. */
function lenient<T extends z.ZodTypeAny, F extends z.infer<T> | undefined>(schema: T, fallback: F) {
  return z.unknown().transform((value): z.infer<T> | F => {
    const result = schema.safeParse(value);
    return result.success ? result.data : fallback;
  });
}

const symbolList = lenient(z.array(z.string()).max(MAX_RUN_SYMBOLS), undefined);
const count = z.number().int().nonnegative();

const checkSchema = z.object({
  symbol: z.string(),
  result: z.enum(EARNINGS_LOOKUP_RESULTS),
  date: lenient(z.string(), undefined),
  reason: lenient(z.string(), undefined),
});
const sourceRunSchema = z.object({
  source: z.enum(EARNINGS_SOURCES),
  status: z.enum(EARNINGS_SOURCE_STATUSES),
  reason: lenient(z.string(), ''),
  rows: lenient(count, undefined),
  events: lenient(count, undefined),
  matchedSymbols: symbolList,
  companies: lenient(count, undefined),
  withDate: lenient(count, undefined),
  checks: lenient(z.array(checkSchema).max(MAX_RUN_SYMBOLS), undefined),
});
const conflictSide = z.object({ source: z.enum(EARNINGS_SOURCES), date: z.string() });
const conflictSchema = z.object({ symbol: z.string(), kept: conflictSide, dropped: conflictSide });

export const earningsRunSchema = z.object({
  at: z.string(),
  trigger: lenient(z.enum(EARNINGS_RUN_TRIGGERS), 'scheduled' as const),
  status: z.enum(EARNINGS_RUN_STATUSES),
  reason: lenient(z.string(), ''),
  tracked: lenient(count, 0),
  rows: lenient(count, undefined),
  events: lenient(count, undefined),
  matchedSymbols: symbolList,
  listed: symbolList,
  unvouched: symbolList,
  sources: lenient(z.array(sourceRunSchema).max(EARNINGS_SOURCES.length), undefined),
  conflicts: lenient(z.array(conflictSchema).max(MAX_RUN_CONFLICTS), undefined),
});

const definedCheck = (check: z.infer<typeof checkSchema>): EarningsCompanyCheck => ({
  symbol: check.symbol,
  result: check.result,
  ...(check.date === undefined ? {} : { date: check.date }),
  ...(check.reason === undefined ? {} : { reason: check.reason }),
});

const definedSourceRun = (source: z.infer<typeof sourceRunSchema>): EarningsSourceRun => ({
  source: source.source,
  status: source.status,
  reason: source.reason,
  ...(source.rows === undefined ? {} : { rows: source.rows }),
  ...(source.events === undefined ? {} : { events: source.events }),
  ...(source.matchedSymbols ? { matchedSymbols: source.matchedSymbols } : {}),
  ...(source.companies === undefined ? {} : { companies: source.companies }),
  ...(source.withDate === undefined ? {} : { withDate: source.withDate }),
  ...(source.checks ? { checks: source.checks.map((check) => definedCheck(check)) } : {}),
});

/** The run a stored item describes; null when there is none or it is not a record of this version. */
export function parseEarningsRun(item: Readonly<Record<string, unknown>> | undefined): EarningsRunRecord | null {
  const parsed = earningsRunSchema.safeParse(item);
  if (!parsed.success) return null;
  const { rows, events, matchedSymbols, listed, unvouched, sources, conflicts, ...run } = parsed.data;
  return {
    ...run,
    ...(rows === undefined ? {} : { rows }),
    ...(events === undefined ? {} : { events }),
    ...(matchedSymbols ? { matchedSymbols } : {}),
    ...(listed ? { listed } : {}),
    ...(unvouched ? { unvouched } : {}),
    ...(sources ? { sources: sources.map((source) => definedSourceRun(source)) } : {}),
    ...(conflicts ? { conflicts } : {}),
  };
}

// --- The report ---------------------------------------------------------------------------------------

export const EARNINGS_NO_DATE_REASONS = ['not-applicable', 'not-tracked', 'never-run', 'since-bought', 'no-provider', 'budget', 'rate-limited', 'failed', 'skipped', 'name-mismatch', 'no-upcoming-date', 'not-listed', 'provider-limited'] as const;
export type EarningsNoDateReason = (typeof EARNINGS_NO_DATE_REASONS)[number];

export interface HeldEarningsDate {
  symbol: string;
  name: string;
  /** The next date as the calendar shows it; null when there is none. */
  next: { date: string; source: CalendarEarningsPhase; timeOfDay: CalendarEarningsTime; status?: CalendarStatus; releaseText?: string } | null;
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
  /** What each source did (absent for runs recorded before there were several). */
  sources?: EarningsSourceRun[];
  conflicts?: EarningsConflict[];
}

/** The verdict on the date sources, for the top of the card. */
export interface EarningsDatesConclusion {
  /** `ok`: dates are coming in; `partial`: they are, but a source is missing or failing; `broken`: no source delivers dates. */
  kind: 'ok' | 'partial' | 'broken';
  text: string;
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
  /** Whether dates are coming in, and what to do when they are not; null before the first run. */
  conclusion: EarningsDatesConclusion | null;
  /** Held companies (the ones that report quarterly results); funds, ETFs and crypto are not counted. */
  held: number;
  /** Of those, how many have a next date. */
  withDate: number;
  /** Held funds, ETFs and crypto positions: they have no earnings and are listed with `reasonCode: 'not-applicable'`. */
  funds: number;
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
        ...(run.sources === undefined ? {} : { sources: run.sources }),
        ...(run.conflicts === undefined ? {} : { conflicts: run.conflicts }),
      };

const CRYPTO = /^[A-Z0-9]+-[A-Z]{3}$/;
const NOT_APPLICABLE_TEXT = 'Fund or crypto: no earnings';
const day = (iso: string): string => iso.slice(0, 10);

interface WhyInput {
  symbol: string;
  name: string;
  /** False for a fund, ETF or crypto position (no quarterly results); absent means a company. */
  hasEarnings?: boolean;
  /** `undefined`: not tracked; null: tracked, since an unknown time. */
  trackedAt: string | null | undefined;
  run: EarningsRunRecord | null;
  lastOk: EarningsRunRecord | null;
}

type Why = { code: EarningsNoDateReason; text: string };

const NO_DATES_ADVICE = 'Add a free Finnhub key (the FINNHUB_API_KEY secret) to get dates and release times.';

/** The cause of a `provider-limited` run: the source that answered with too few rows. */
function limitedText(run: EarningsRunRecord): string {
  const limited = run.sources?.find((source) => source.status === 'provider-limited');
  const rows = limited?.rows ?? run.rows;
  return `Alpha Vantage returned only ${rows ?? 'a few'} rows: its free plan does not provide the earnings calendar for this key`;
}

/** Why the last attempt did not read the provider's calendar. */
function failureWhy(run: EarningsRunRecord): Why {
  const when = day(run.at);
  switch (run.status) {
    case 'rate-limited':
      return { code: 'rate-limited', text: `The Alpha Vantage rate limit was reached on ${when}: ${run.reason}. Nothing was read.` };
    case 'budget-exhausted':
      return { code: 'budget', text: `The daily Alpha Vantage allowance for the calendar was already used on ${when}, so the job did not call the provider.` };
    case 'provider-limited':
      return { code: 'provider-limited', text: `${limitedText(run)} (${when}). ${NO_DATES_ADVICE}` };
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

/** `Finnhub: 14 of 17 companies have a date` of a source that is asked company by company; null for a source that lists every company at once. */
export function companiesSummary(source: EarningsSourceRun): string | null {
  if (source.companies === undefined) return null;
  return `${SOURCE_LABELS[source.source]}: ${source.withDate ?? 0} of ${source.companies} ${source.companies === 1 ? 'company has' : 'companies have'} a date`;
}

/** `Alpha Vantage: 4203 rows; Finnhub: 14 of 17 companies have a date` of the sources that answered. */
function sourcesSummary(sources: readonly EarningsSourceRun[]): string {
  return sources
    .filter((source) => source.status === 'ok' || source.status === 'provider-limited')
    .map((source) => companiesSummary(source) ?? `${SOURCE_LABELS[source.source]}: ${source.rows ?? 0} rows`)
    .join('; ');
}

/** Why Finnhub, asked about this company, gave no date. */
function checkWhy(check: EarningsCompanyCheck, when: string): Why {
  const cause = check.reason === undefined || check.reason === '' ? '' : `: ${check.reason}`;
  switch (check.result) {
    case 'pending':
      return { code: 'budget', text: `Finnhub was not asked about it in the run of ${when}: the daily allowance or the run ended first. It is next in line.` };
    case 'rate-limited':
      return { code: 'rate-limited', text: `Finnhub's rate limit was reached before it was looked up on ${when}${cause}.` };
    case 'refused':
      return { code: 'failed', text: `Finnhub refused the request on ${when}${cause}.` };
    case 'failed':
      return { code: 'failed', text: `Finnhub could not look it up on ${when}${cause}.` };
    default:
      return { code: 'no-upcoming-date', text: `Finnhub was asked about it on ${when} and has no upcoming date for it yet.` };
  }
}

/** The provider answered (`run`): why it has no upcoming date for the symbol. */
function answerWhy({ symbol, name }: WhyInput, run: EarningsRunRecord): Why {
  const when = day(run.at);
  if (run.unvouched?.includes(symbol)) return { code: 'name-mismatch', text: `The provider lists the ticker, but for a company whose name does not match "${name}", so its date was not taken (${when}).` };
  const check = run.sources?.find((source) => source.source === 'finnhub')?.checks?.find((entry) => entry.symbol === symbol);
  if (check !== undefined && check.result !== 'date') return checkWhy(check, when);
  if (run.listed?.includes(symbol)) return { code: 'no-upcoming-date', text: `The provider lists it, but with no upcoming date (${when}).` };
  if (run.sources !== undefined) return { code: 'not-listed', text: `Not listed by the sources that answered on ${when}: ${sourcesSummary(run.sources)}.` };
  const rows = run.rows === undefined ? 'its calendar' : `its calendar of ${run.rows} rows`;
  return { code: 'not-listed', text: `Not in the provider's calendar: ${rows} (${when}) has no row for ${symbol}.` };
}

/** Why a held symbol has no upcoming earnings date. */
export function whyNoEarningsDate(input: WhyInput): Why {
  const { symbol, trackedAt, run, lastOk } = input;
  if (input.hasEarnings === false || CRYPTO.test(symbol)) return { code: 'not-applicable', text: NOT_APPLICABLE_TEXT };
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
  held: readonly { symbol: string; name: string; hasEarnings?: boolean }[];
  /** `createdAt` of the tracked-ticker item of each tracked symbol (null: tracked, time unknown). */
  tracked: ReadonlyMap<string, string | null>;
  /** The next event per symbol as the calendar shows it (see `nextEarningsEvents`). */
  next: ReadonlyMap<string, CalendarEvent>;
  run: EarningsRunRecord | null;
  lastOk: EarningsRunRecord | null;
  budget: ProviderBudgetReport | null;
  refresh: RefreshReport;
  /** Which date sources have a key on this deployment; when absent the last run's record decides. */
  configured?: Readonly<Record<EarningsSourceName, boolean>>;
}

const isCompany = (entry: { symbol: string; hasEarnings?: boolean }): boolean => entry.hasEarnings !== false && !CRYPTO.test(entry.symbol);

const nextOf = (event: CalendarEvent): NonNullable<HeldEarningsDate['next']> => ({
  date: event.date,
  source: event.earningsPhase ?? 'scheduled',
  timeOfDay: event.timeOfDay ?? 'unknown',
  status: event.status,
  ...(event.release === undefined ? {} : { releaseText: event.release.text }),
});

// --- Conclusion ---------------------------------------------------------------------------------------

const PROJECTION_ONLY = 'Until then every date in the calendar is a projection (previous report + about 91 days).';

/** What one source did, from the record of the run (an old record has the Alpha Vantage attempt only, in its own fields). */
function sourceRuns(run: EarningsRunRecord, configured: EarningsDatesInput['configured']): EarningsSourceRun[] {
  const recorded = run.sources ?? [{ source: 'alphavantage' as const, status: legacyStatus(run), reason: run.reason, rows: run.rows, events: run.events }];
  return EARNINGS_SOURCES.map((source): EarningsSourceRun => {
    const found = recorded.find((entry) => entry.source === source);
    if (configured !== undefined && !configured[source]) return { source, status: 'no-key', reason: '' };
    return found ?? { source, status: 'no-key', reason: '' };
  });
}

function legacyStatus(run: EarningsRunRecord): EarningsSourceStatus {
  if (run.status === 'ok' || run.status === 'provider-limited' || run.status === 'rate-limited' || run.status === 'budget-exhausted') return run.status;
  return run.status === 'no-provider' ? 'no-key' : 'failed';
}

const inBrackets = (reason: string): string => (reason === '' ? '' : ` (${reason})`);
const afterColon = (reason: string): string => (reason === '' ? '' : `: ${reason}`);

function sourceProblem(entry: EarningsSourceRun): string {
  const label = SOURCE_LABELS[entry.source];
  switch (entry.status) {
    case 'provider-limited':
      return `${label} returned only ${entry.rows ?? 'a few'} rows: its free plan does not provide the earnings calendar for this key.`;
    case 'no-key':
      return `${label} is not configured${entry.source === 'finnhub' ? ': add a free key (the FINNHUB_API_KEY secret)' : ' (no ALPHAVANTAGE_API_KEY secret)'}.`;
    case 'budget-exhausted':
      return `${label}: the daily allowance for the calendar was already used.`;
    case 'rate-limited':
      return `${label}: rate limit reached${inBrackets(entry.reason)}.`;
    case 'refused':
      return `${label} refused the request${inBrackets(entry.reason)}: check the ${entry.source === 'finnhub' ? 'FINNHUB_API_KEY' : 'ALPHAVANTAGE_API_KEY'} secret (it must be a valid key).`;
    default:
      return `${label} failed${afterColon(entry.reason)}.`;
  }
}

/** The verdict on the date sources, from the last run: working, partly working, or no source delivering dates. Null before the first run. */
export function earningsDatesConclusion(last: EarningsRunRecord | null, configured?: EarningsDatesInput['configured'], lastOk: EarningsRunRecord | null = null): EarningsDatesConclusion | null {
  // A run that found the day's calls already spent (a second run the same day) says nothing about the sources: the last one that read them does.
  const run = last?.status === 'budget-exhausted' && lastOk !== null ? lastOk : last;
  if (run === null || run.status === 'skipped') return null;
  const entries = sourceRuns(run, configured);
  const working = entries.filter((entry) => entry.status === 'ok');
  // A source that found its allowance of the day already spent (a second run the same day) is no problem while another source delivers: it reads again tomorrow.
  const problems = entries.filter((entry) => entry.status !== 'ok' && !(entry.status === 'budget-exhausted' && working.length > 0)).map((entry) => sourceProblem(entry));
  if (working.length === 0) return { kind: 'broken', text: `No provider date source is working. ${problems.join(' ')} ${PROJECTION_ONLY}` };
  const names = working.map((entry) => SOURCE_LABELS[entry.source]).join(' and ');
  if (problems.length === 0) return { kind: 'ok', text: `Dates come from ${names}.` };
  return { kind: 'partial', text: `Dates come from ${names}. ${problems.join(' ')}` };
}

/** The report: companies without a date first (by symbol), then the ones with the earliest date first, then funds and crypto (no earnings). */
export function buildEarningsDatesReport(input: EarningsDatesInput): EarningsDatesResponse {
  const { now, run, lastOk } = input;
  const symbols = input.held.map((entry): HeldEarningsDate => {
    const { symbol, name } = entry;
    const event = isCompany(entry) ? input.next.get(symbol) : undefined;
    if (event) return { symbol, name, next: nextOf(event), reasonCode: null, reason: null };
    const why = whyNoEarningsDate({ symbol, name, hasEarnings: entry.hasEarnings, trackedAt: input.tracked.get(symbol), run, lastOk });
    return { symbol, name, next: null, reasonCode: why.code, reason: why.text };
  });
  symbols.sort((a, b) => {
    const aFund = a.reasonCode === 'not-applicable';
    if (aFund !== (b.reasonCode === 'not-applicable')) return aFund ? 1 : -1;
    if (a.next === null && b.next !== null) return -1;
    if (a.next !== null && b.next === null) return 1;
    return (a.next?.date ?? '').localeCompare(b.next?.date ?? '') || a.symbol.localeCompare(b.symbol);
  });
  const companies = input.held.filter(isCompany);
  const heldSymbols = new Set(companies.map((entry) => entry.symbol));
  return {
    asOf: now.toISOString(),
    today: now.toISOString().slice(0, 10),
    lastRun: reportOf(run, heldSymbols),
    lastSuccess: reportOf(lastOk, heldSymbols),
    budget: input.budget,
    refresh: input.refresh,
    conclusion: earningsDatesConclusion(run, input.configured, lastOk),
    held: companies.length,
    withDate: symbols.filter((entry) => entry.next !== null).length,
    funds: input.held.length - companies.length,
    symbols,
  };
}

const iso = z.string().min(1);
const sourceRunReport = z.object({
  source: z.enum(EARNINGS_SOURCES),
  status: z.enum(EARNINGS_SOURCE_STATUSES),
  reason: z.string(),
  rows: count.optional(),
  events: count.optional(),
  matchedSymbols: z.array(z.string()).optional(),
  companies: count.optional(),
  withDate: count.optional(),
  checks: z.array(z.object({ symbol: z.string(), result: z.enum(EARNINGS_LOOKUP_RESULTS), date: z.string().optional(), reason: z.string().optional() })).optional(),
});
const conflictSideReport = z.object({ source: z.enum(EARNINGS_SOURCES), date: z.string() });
const runReport = z.object({
  at: iso,
  trigger: z.enum(EARNINGS_RUN_TRIGGERS),
  status: z.enum(EARNINGS_RUN_STATUSES),
  reason: z.string(),
  tracked: count,
  rows: count.nullable(),
  events: count.nullable(),
  matchedHeld: count.nullable(),
  sources: z.array(sourceRunReport).optional(),
  conflicts: z.array(z.object({ symbol: z.string(), kept: conflictSideReport, dropped: conflictSideReport })).optional(),
});

/** Validates the response of `GET /diagnostics/earnings-dates` (the web client parses it with this). */
export const earningsDatesSchema = z.object({
  asOf: iso,
  today: iso,
  lastRun: runReport.nullable(),
  lastSuccess: runReport.nullable(),
  budget: z.object({ provider: z.literal('Alpha Vantage'), day: iso, used: count, limit: count, remaining: count, calendarUsed: count, calendarLimit: count }).nullable(),
  refresh: z.object({ available: z.boolean(), reason: z.string().nullable(), nextAllowedAt: z.string().nullable() }),
  conclusion: z.object({ kind: z.enum(['ok', 'partial', 'broken']), text: z.string() }).nullable().default(null),
  held: count,
  withDate: count,
  funds: count.default(0),
  symbols: z.array(
    z.object({
      symbol: z.string(),
      name: z.string(),
      next: z
        .object({ date: iso, source: z.enum(['reported', 'scheduled', 'projected']), timeOfDay: z.enum(CALENDAR_EARNINGS_TIMES), status: z.enum(CALENDAR_STATUSES).optional(), releaseText: z.string().optional() })
        .nullable(),
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
