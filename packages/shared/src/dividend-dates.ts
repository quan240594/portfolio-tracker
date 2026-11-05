/**
 * Dividend dates diagnostics (Settings > Diagnostics > "Dividend dates"): for every held symbol the next dividend as the calendar shows it,
 * the latest stored one, when and how its dividends were last checked, and why there is no declared upcoming date. Pure; the API route loads the data.
 *
 * - GET  /diagnostics/dividend-dates          the held symbols with their dates, the EODHD allowance of the day, the state of the free fallback feed
 * - POST /diagnostics/dividend-dates/refresh  queues a dividends-only calendar run once (Cloudflare deployment; once an hour, and only while EODHD
 *                                             calls of the day are left); 202 `{accepted: true}`, 429 `RATE_LIMITED` with `details.reason`
 *                                             (`rate-limited` or `budget-low`), 503 `NOT_CONFIGURED` (no EODHD key), 404 `NOT_AVAILABLE` (AWS)
 *
 * Stored by the price job next to the calendar markers: the outcome of the last dividends check on the symbol's `CAL#STATE` item
 * ({@link DividendCheckState}) and, in the `CALENDAR` partition, what the Alpha Vantage `DIVIDENDS` feed answered on this key (`DIVIDENDS#AVFEED`).
 */
import { z } from 'zod';
import { addIsoDays, daysBetween } from './analytics.js';
import { dividendOutlook, type CalendarEvent } from './calendar.js';
import type { RefreshReport } from './earnings-dates.js';
import { MANUAL_DIVIDEND_SOURCE } from './dividend-merge.js';
import { currentHoldings } from './notification-events.js';
import type { DividendEvent, FxDay, FxRates, InstrumentProfile, Transaction } from './types.js';

export const DIVIDEND_DATES_ROUTES = {
  dividendDates: 'GET /diagnostics/dividend-dates',
  refreshDividendDates: 'POST /diagnostics/dividend-dates/refresh',
} as const;

/** How the last dividends check of a symbol ended: it listed events, it listed none, it failed, a limit was reached, or the allowance of the day was spent first (not asked). */
export const DIVIDEND_CHECK_OUTCOMES = ['ok', 'none', 'failed', 'rate-limited', 'budget'] as const;
export type DividendCheckOutcome = (typeof DIVIDEND_CHECK_OUTCOMES)[number];

/** Who answered the check. */
export const DIVIDEND_CHECK_SOURCES = ['eodhd', 'alphavantage'] as const;
export type DividendCheckSource = (typeof DIVIDEND_CHECK_SOURCES)[number];

export const DIVIDEND_SOURCE_LABELS: Readonly<Record<DividendCheckSource | typeof MANUAL_DIVIDEND_SOURCE, string>> = { eodhd: 'EODHD', alphavantage: 'Alpha Vantage', manual: 'entered by you' };

/** The last attempt to read a symbol's dividends. */
export interface DividendAttempt {
  at: string;
  outcome: DividendCheckOutcome;
  /** Sanitized one-line cause (`failed`, `rate-limited`); empty otherwise. */
  reason: string;
  source: DividendCheckSource;
  /** Dividend records the answer held (0 for `none`). */
  events: number;
}

/** What the symbol's `CAL#STATE` item says about its dividends: when they were last read successfully, and the last attempt whatever its outcome. */
export interface DividendCheckState {
  checkedAt?: string;
  attempt?: DividendAttempt;
}

const lenientString = z.unknown().transform((value): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined));
const attemptFields = z.object({
  dividendsAttemptAt: lenientString,
  dividendsOutcome: z.unknown().transform((value) => DIVIDEND_CHECK_OUTCOMES.find((outcome) => outcome === value)),
  dividendsReason: z.unknown().transform((value) => (typeof value === 'string' ? value : '')),
  dividendsSource: z.unknown().transform((value) => DIVIDEND_CHECK_SOURCES.find((source) => source === value) ?? 'eodhd'),
  dividendsEvents: z.unknown().transform((value) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0)),
  dividendsCheckedAt: lenientString,
});

/** The dividends marker of a `CAL#STATE` item (as the Python service or the TypeScript job wrote it); undefined when it says nothing. */
export function parseDividendCheckState(item: Readonly<Record<string, unknown>> | undefined): DividendCheckState | undefined {
  if (item === undefined) return undefined;
  const parsed = attemptFields.safeParse(item);
  if (!parsed.success) return undefined;
  const { dividendsAttemptAt: at, dividendsOutcome: outcome, dividendsReason: reason, dividendsSource: source, dividendsEvents: events, dividendsCheckedAt: checkedAt } = parsed.data;
  const attempt = at !== undefined && outcome !== undefined ? { attempt: { at, outcome, reason, source, events } } : {};
  const state: DividendCheckState = { ...(checkedAt === undefined ? {} : { checkedAt }), ...attempt };
  return state.checkedAt === undefined && state.attempt === undefined ? undefined : state;
}

// --- The free fallback feed (Alpha Vantage DIVIDENDS) -------------------------------------------------------

export const DIVIDEND_FEED_KEY = { PK: 'CALENDAR', SK: 'DIVIDENDS#AVFEED' } as const;
export const DIVIDEND_FEED_ENTITY = 'DIVIDEND_FEED';
/** A feed found unavailable on the key is tried again after this many days (a plan can change). */
export const DIVIDEND_FEED_RETRY_DAYS = 7;

export const DIVIDEND_FEED_STATUSES = ['available', 'unavailable'] as const;
export type DividendFeedStatus = (typeof DIVIDEND_FEED_STATUSES)[number];

/** What the first real call (and each later one) found out about the feed on this key. */
export interface DividendFeedState {
  status: DividendFeedStatus;
  at: string;
  /** The provider's own words (sanitized) when it is unavailable. */
  reason: string;
}

export function parseDividendFeedState(item: Readonly<Record<string, unknown>> | undefined): DividendFeedState | undefined {
  if (item === undefined) return undefined;
  const status = DIVIDEND_FEED_STATUSES.find((candidate) => candidate === item.status);
  if (status === undefined || typeof item.at !== 'string') return undefined;
  return { status, at: item.at, reason: typeof item.reason === 'string' ? item.reason : '' };
}

/** Whether an unavailable feed is due to be tried again. */
export const feedRetryDue = (feed: DividendFeedState, now: Date): boolean => now.getTime() - Date.parse(feed.at) >= DIVIDEND_FEED_RETRY_DAYS * 86_400_000;

// --- Refresh ------------------------------------------------------------------------------------------------

/** A manual check is refused when fewer EODHD calls than this are left today (the quote refresh needs some too). */
export const MIN_EODHD_CALLS_FOR_CHECK = 3;
/** Symbols a manual check reads (one EODHD call each, plus one Alpha Vantage call where the fallback is used). */
export const MANUAL_CHECK_SYMBOLS = 8;

// --- The report ---------------------------------------------------------------------------------------------

export const DIVIDEND_NO_DATE_REASONS = ['not-tracked', 'never-checked', 'since-bought', 'no-provider', 'budget', 'rate-limited', 'failed', 'none-returned', 'no-history', 'after-ex-date', 'estimate-only'] as const;
export type DividendNoDateReason = (typeof DIVIDEND_NO_DATE_REASONS)[number];

export interface DividendDateInfo {
  exDate: string | null;
  payDate: string | null;
  /** Per share, in `currency`; null when the amount is not known (an entry of yours without one). */
  amount: number | null;
  currency: string | null;
  /** `eodhd`, `alphavantage`, `manual` (entered by you), `provider` (stored before sources were recorded) or `history` (a projection from your payments). */
  source: string;
  kind: 'declared' | 'estimated';
  enteredByYou: boolean;
}

export interface DividendCheckReport {
  /** Last successful read. */
  checkedAt: string | null;
  /** Last attempt, whatever its outcome. */
  attemptAt: string | null;
  outcome: DividendCheckOutcome | null;
  reason: string;
  source: DividendCheckSource | null;
  events: number | null;
}

export interface HeldDividendDate {
  symbol: string;
  name: string;
  /** Day (YYYY-MM-DD) of your first transaction in it; null when unknown. */
  boughtOn: string | null;
  /** The next declared dividend, else the projected one; null when there is none. */
  next: DividendDateInfo | null;
  /** The latest stored dividend with an ex-date on or before today. */
  last: DividendDateInfo | null;
  check: DividendCheckReport;
  /** Why there is no declared upcoming date (null when there is one). */
  reasonCode: DividendNoDateReason | null;
  reason: string | null;
}

/** The EODHD allowance of the UTC day: every call of the app (quotes, history, splits, dividends) counts. */
export interface DividendBudgetReport {
  provider: 'EODHD';
  day: string;
  used: number;
  limit: number;
  remaining: number;
  /** Calls the calendar's daily rotation may use, and has used today. */
  calendarUsed: number;
  calendarLimit: number;
}

export const FEED_REPORT_STATUSES = ['no-key', 'untested', 'available', 'unavailable'] as const;

export interface DividendFeedReport {
  source: 'Alpha Vantage';
  status: (typeof FEED_REPORT_STATUSES)[number];
  at: string | null;
  /** When an unavailable feed is tried again. */
  retryAt: string | null;
  reason: string;
}

export interface DividendDatesResponse {
  asOf: string;
  today: string;
  budget: DividendBudgetReport | null;
  refresh: RefreshReport;
  feed: DividendFeedReport;
  /** Which sources have a key on this deployment (null where the deployment cannot say). */
  configured: { eodhd: boolean; alphavantage: boolean } | null;
  /** Held symbols that can pay a dividend (no crypto; ETFs count). */
  held: number;
  /** Of those, how many have a declared upcoming dividend. */
  withDeclared: number;
  symbols: HeldDividendDate[];
}

export type GetDividendDatesResponse = DividendDatesResponse;
export type RefreshDividendDatesResponse = { accepted: true };

const CRYPTO = /^[A-Z0-9]+-[A-Z]{3}$/;
const day = (iso: string): string => iso.slice(0, 10);
const DEFAULT_CADENCE_DAYS = 91;
const MAX_CADENCE_SAMPLES = 4;

type Why = { code: DividendNoDateReason; text: string };

/** The positions held on `today` that can pay a dividend (market symbols, ETFs included, crypto not), each with the day of its first transaction. */
export function heldDividendPayers(transactions: readonly Transaction[], today: string): Map<string, string> {
  const since = new Map<string, string>();
  for (const symbol of currentHoldings(transactions, today).held) {
    if (CRYPTO.test(symbol)) continue;
    const days = transactions.filter((transaction) => transaction.symbol === symbol && transaction.date <= today).map((transaction) => transaction.date).sort((a, b) => a.localeCompare(b));
    since.set(symbol, days[0] ?? today);
  }
  return since;
}

/** Median gap in days between the last few stored ex-dates (about a quarter without two of them). */
export function dividendCadenceDays(events: readonly DividendEvent[]): number {
  const dates = events.map((event) => event.exDate).sort((a, b) => a.localeCompare(b)).slice(-(MAX_CADENCE_SAMPLES + 1));
  const gaps = dates.slice(1).map((date, index) => daysBetween(dates[index]!, date)).filter((gap) => gap > 0).sort((a, b) => a - b);
  return gaps.length === 0 ? DEFAULT_CADENCE_DAYS : gaps[Math.floor(gaps.length / 2)]!;
}

function expectationText(events: readonly DividendEvent[], today: string): string {
  const latest = events.map((event) => event.exDate).sort((a, b) => b.localeCompare(a))[0]!;
  const gap = dividendCadenceDays(events);
  const expected = addIsoDays(latest, gap);
  const timing = expected < today ? 'It is overdue' : `The next one is expected around ${expected}`;
  return `Latest stored ex-date ${latest}; with about ${gap} days between dividends. ${timing}.`;
}

export interface DividendFacts {
  symbol: string;
  today: string;
  /** Start of the day of the first transaction (ISO), or null. */
  boughtAt: string | null;
  /** `createdAt` of the tracked item: undefined: not tracked; null: tracked, since an unknown time. */
  trackedAt: string | null | undefined;
  state: DividendCheckState | undefined;
  events: readonly DividendEvent[];
  /** Whether the deployment has an EODHD key (undefined: it cannot say). */
  eodhdKey: boolean | undefined;
}

const latestOf = (state: DividendCheckState): string => [state.checkedAt ?? '', state.attempt?.at ?? ''].sort((a, b) => b.localeCompare(a))[0]!;

/** The cause of an attempt that did not read the dividends. */
function attemptWhy(attempt: DividendAttempt, state: DividendCheckState): Why | null {
  const when = day(attempt.at);
  const earlier = state.checkedAt === undefined ? 'It has never been read successfully.' : `Last read successfully on ${day(state.checkedAt)}.`;
  const cause = attempt.reason === '' ? '' : `: ${attempt.reason}`;
  switch (attempt.outcome) {
    case 'budget':
      return { code: 'budget', text: `Skipped on ${when}: the day's allowance for the calendar was used up before its turn. ${earlier}` };
    case 'rate-limited':
      return { code: 'rate-limited', text: `The provider's limit was reached on ${when}${cause}. ${earlier}` };
    case 'failed':
      return { code: 'failed', text: `The check failed on ${when}${cause}. ${earlier}` };
    default:
      return null;
  }
}

/** The latest moment the symbol must have been read after: when it was tracked and when it was first bought (the later one). */
function boughtSince(facts: DividendFacts): string | undefined {
  return [facts.trackedAt ?? null, facts.boughtAt].filter((value): value is string => value !== null).sort((a, b) => b.localeCompare(a))[0];
}

/** The cause of a read that did not deliver (the latest attempt, when it is newer than the last successful read), or null. */
function lastAttemptWhy(state: DividendCheckState): Why | null {
  const { attempt } = state;
  if (attempt === undefined || (state.checkedAt !== undefined && attempt.at < state.checkedAt)) return null;
  return attemptWhy(attempt, state);
}

/** The provider answered: it lists nothing at all for the symbol, or nothing upcoming. */
function answeredWhy(state: DividendCheckState, events: readonly DividendEvent[], today: string): Why {
  const source = state.attempt === undefined ? 'The provider' : DIVIDEND_SOURCE_LABELS[state.attempt.source];
  const when = day(state.checkedAt ?? state.attempt?.at ?? latestOf(state));
  if (events.length === 0) return { code: 'no-history', text: `${source} was asked on ${when} and has never listed a dividend for it: it may not pay one.` };
  return { code: 'none-returned', text: `${source} was asked on ${when} and lists no upcoming dividend. ${expectationText(events, today)}` };
}

/** Why a held symbol has no declared upcoming dividend. */
export function whyNoDeclaredDividend(facts: DividendFacts): Why {
  const { state, trackedAt, events, today } = facts;
  if (trackedAt === undefined && state === undefined) return { code: 'not-tracked', text: 'Not tracked yet: dividends are only looked up for tracked symbols, and this one is registered when its transaction is saved or its price history is fetched.' };
  if (state === undefined) {
    if (facts.eodhdKey === false) return { code: 'no-provider', text: 'No EODHD key is set on this deployment, so dividend dates are not looked up.' };
    return { code: 'never-checked', text: 'Its dividends have not been checked yet: the daily run reads a few symbols a day and puts new ones first.' };
  }
  const since = boughtSince(facts);
  if (since !== undefined && latestOf(state) < since) return { code: 'since-bought', text: `Its dividends have not been checked since you bought it (first transaction ${day(since)}, last check ${day(latestOf(state))}).` };
  return lastAttemptWhy(state) ?? answeredWhy(state, events, today);
}

const NO_CHECK: DividendCheckReport = { checkedAt: null, attemptAt: null, outcome: null, reason: '', source: null, events: null };

function checkReport(state: DividendCheckState | undefined): DividendCheckReport {
  if (state === undefined) return NO_CHECK;
  const { attempt } = state;
  return {
    checkedAt: state.checkedAt ?? null,
    attemptAt: attempt?.at ?? null,
    outcome: attempt?.outcome ?? null,
    reason: attempt?.reason ?? '',
    source: attempt?.source ?? null,
    events: attempt?.events ?? null,
  };
}

function infoOfStored(event: DividendEvent): DividendDateInfo {
  const source = event.source ?? 'provider';
  return { exDate: event.exDate, payDate: event.payDate ?? null, amount: event.amount > 0 ? event.amount : null, currency: event.currency, source, kind: 'declared', enteredByYou: source === MANUAL_DIVIDEND_SOURCE };
}

/** The upcoming entry of a symbol as the calendar lists it: declared ones before projected ones, the earliest first. */
function nextEntry(entries: readonly CalendarEvent[], symbol: string, today: string): CalendarEvent | undefined {
  const upcoming = entries.filter((entry) => entry.symbol === symbol && entry.status !== 'PAID' && entry.date >= today);
  return upcoming.find((entry) => entry.status === 'CONFIRMED') ?? upcoming[0];
}

function infoOfEntry(entry: CalendarEvent, events: readonly DividendEvent[]): DividendDateInfo {
  const stored = events.find((event) => event.exDate === entry.exDate);
  if (entry.status === 'CONFIRMED' && stored !== undefined) return infoOfStored(stored);
  const estimated = entry.status === 'ESTIMATED';
  return {
    exDate: entry.exDate ?? null,
    payDate: entry.payDate ?? null,
    amount: entry.amountPerShare === undefined || entry.amountPerShare <= 0 ? null : entry.amountPerShare,
    currency: entry.currency ?? null,
    source: estimated ? 'history' : (stored?.source ?? 'provider'),
    kind: estimated ? 'estimated' : 'declared',
    enteredByYou: false,
  };
}

/** A stored dividend that has not been paid yet but is not in the calendar: you held no shares before its ex-date. */
const unentitled = (events: readonly DividendEvent[], today: string): DividendEvent | undefined =>
  events.filter((event) => (event.payDate ?? event.exDate) >= today).sort((a, b) => a.exDate.localeCompare(b.exDate))[0];

export interface DividendDatesInput {
  now: Date;
  transactions: readonly Transaction[];
  profiles: Readonly<Record<string, InstrumentProfile>>;
  fx: FxRates;
  fxHistory?: readonly FxDay[];
  /** Stored events with the owner's own entries already added (see `withManualDividends`). */
  dividendEvents: readonly DividendEvent[];
  /** `createdAt` of the tracked-ticker item of each tracked symbol (null: tracked, time unknown). */
  tracked: ReadonlyMap<string, string | null>;
  states: ReadonlyMap<string, DividendCheckState>;
  budget: DividendBudgetReport | null;
  refresh: RefreshReport;
  /** The feed's recorded state, and whether an Alpha Vantage key is set. */
  feed: DividendFeedState | undefined;
  configured?: { eodhd: boolean; alphavantage: boolean };
}

const firstTransactionDay = (transactions: readonly Transaction[], symbol: string, today: string): string | null =>
  transactions.filter((transaction) => transaction.symbol === symbol && transaction.date <= today).map((transaction) => transaction.date).sort((a, b) => a.localeCompare(b))[0] ?? null;

function feedReport(input: DividendDatesInput): DividendFeedReport {
  const { feed, configured, now } = input;
  if (configured?.alphavantage === false) return { source: 'Alpha Vantage', status: 'no-key', at: null, retryAt: null, reason: 'No Alpha Vantage key is set, so the free fallback is off.' };
  if (feed === undefined) return { source: 'Alpha Vantage', status: 'untested', at: null, retryAt: null, reason: 'The first fallback call has not been made yet: it is made for a symbol EODHD lists no declared upcoming dividend for.' };
  if (feed.status === 'available') return { source: 'Alpha Vantage', status: 'available', at: feed.at, retryAt: null, reason: '' };
  const retryAt = new Date(Date.parse(feed.at) + DIVIDEND_FEED_RETRY_DAYS * 86_400_000).toISOString();
  return { source: 'Alpha Vantage', status: 'unavailable', at: feed.at, retryAt: feedRetryDue(feed, now) ? null : retryAt, reason: feed.reason };
}

function symbolReport(input: DividendDatesInput, entries: readonly CalendarEvent[], symbol: string, today: string): HeldDividendDate {
  const events = input.dividendEvents.filter((event) => event.symbol === symbol);
  const state = input.states.get(symbol);
  const boughtOn = firstTransactionDay(input.transactions, symbol, today);
  const entry = nextEntry(entries, symbol, today);
  const next = entry === undefined ? null : infoOfEntry(entry, events);
  const latest = events.filter((event) => event.exDate <= today).sort((a, b) => b.exDate.localeCompare(a.exDate))[0];
  const base = { symbol, name: input.profiles[symbol]?.name ?? symbol, boughtOn, last: latest === undefined ? null : infoOfStored(latest), check: checkReport(state) };
  if (next?.kind === 'declared') return { ...base, next, reasonCode: null, reason: null };
  const missed = entry === undefined ? unentitled(events, today) : undefined;
  if (missed !== undefined) {
    return { ...base, next: null, reasonCode: 'after-ex-date', reason: `A dividend with ex-date ${missed.exDate} is stored, but you held no shares before it (first transaction ${boughtOn ?? 'unknown'}), so it is not yours.` };
  }
  const why = whyNoDeclaredDividend({ symbol, today, boughtAt: boughtOn === null ? null : `${boughtOn}T00:00:00.000Z`, trackedAt: input.tracked.get(symbol), state, events, eodhdKey: input.configured?.eodhd });
  if (next === null) return { ...base, next, reasonCode: why.code, reason: why.text };
  return { ...base, next, reasonCode: 'estimate-only', reason: `Only a projection from your payment history: no declared dividend is stored. ${why.text}` };
}

/** Companies without a declared date first (by symbol), then the ones with the earliest date first. */
const byUrgency = (a: HeldDividendDate, b: HeldDividendDate): number => {
  const aDeclared = a.next?.kind === 'declared';
  if (aDeclared !== (b.next?.kind === 'declared')) return aDeclared ? 1 : -1;
  return (a.next?.exDate ?? '').localeCompare(b.next?.exDate ?? '') || a.symbol.localeCompare(b.symbol);
};

/** The report: every held symbol that can pay a dividend, and the state of the sources. */
export function buildDividendDatesReport(input: DividendDatesInput): DividendDatesResponse {
  const today = day(input.now.toISOString());
  const symbols = [...heldDividendPayers(input.transactions, today).keys()];
  const entries = dividendOutlook({ today, transactions: input.transactions, profiles: input.profiles, fx: input.fx, fxHistory: input.fxHistory, dividendEvents: input.dividendEvents, watchlist: [] });
  const reports = symbols.map((symbol) => symbolReport(input, entries, symbol, today)).sort(byUrgency);
  return {
    asOf: input.now.toISOString(),
    today,
    budget: input.budget,
    refresh: input.refresh,
    feed: feedReport(input),
    configured: input.configured ?? null,
    held: reports.length,
    withDeclared: reports.filter((report) => report.next?.kind === 'declared').length,
    symbols: reports,
  };
}

const iso = z.string().min(1);
const count = z.number().int().nonnegative();
const dateInfo = z
  .object({
    exDate: z.string().nullable(),
    payDate: z.string().nullable(),
    amount: z.number().nullable(),
    currency: z.string().nullable(),
    source: z.string(),
    kind: z.enum(['declared', 'estimated']),
    enteredByYou: z.boolean(),
  })
  .nullable();

/** Validates the response of `GET /diagnostics/dividend-dates` (the web client parses it with this). */
export const dividendDatesSchema = z.object({
  asOf: iso,
  today: iso,
  budget: z.object({ provider: z.literal('EODHD'), day: iso, used: count, limit: count, remaining: count, calendarUsed: count, calendarLimit: count }).nullable(),
  refresh: z.object({ available: z.boolean(), reason: z.string().nullable(), nextAllowedAt: z.string().nullable() }),
  feed: z.object({ source: z.literal('Alpha Vantage'), status: z.enum(FEED_REPORT_STATUSES), at: z.string().nullable(), retryAt: z.string().nullable(), reason: z.string() }),
  configured: z.object({ eodhd: z.boolean(), alphavantage: z.boolean() }).nullable(),
  held: count,
  withDeclared: count,
  symbols: z.array(
    z.object({
      symbol: z.string(),
      name: z.string(),
      boughtOn: z.string().nullable(),
      next: dateInfo,
      last: dateInfo,
      check: z.object({
        checkedAt: z.string().nullable(),
        attemptAt: z.string().nullable(),
        outcome: z.enum(DIVIDEND_CHECK_OUTCOMES).nullable(),
        reason: z.string(),
        source: z.enum(DIVIDEND_CHECK_SOURCES).nullable(),
        events: count.nullable(),
      }),
      reasonCode: z.enum(DIVIDEND_NO_DATE_REASONS).nullable(),
      reason: z.string().nullable(),
    }),
  ),
});
