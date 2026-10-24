/**
 * Price-history coverage: for every held symbol, how much of its end-of-day history is stored, and why a gap is there.
 * Pure functions (the loader that reads the rows lives with the Hub, see `GET /prices/status`). A symbol without a stored close
 * is valued at its average cost on the days before its first close (`buildValueSeries`), so the dashboard chart needs the same
 * facts: `valuedAtCostOf` reduces a value series to the note under the chart.
 */
import { z } from 'zod';
import type { ValueSeries } from './portfolio.js';

/** Rows may start or end this many days off the wanted range and still count as complete (weekends, holidays, a Sunday trade). */
export const COVERAGE_TOLERANCE_DAYS = 4;
/** Longest stretch before today that has to be covered. */
export const COVERAGE_WINDOW_DAYS = 365;
/** Symbols examined per report. */
export const MAX_COVERAGE_SYMBOLS = 60;
/** Newest EOD rows read per symbol: more than the window holds (about 260 trading days a year). */
export const MAX_COVERAGE_ROWS = 400;
export const MAX_ATTEMPT_ERROR_CHARS = 120;

export const HISTORY_STATES = ['complete', 'partial', 'missing'] as const;
export type HistoryState = (typeof HISTORY_STATES)[number];

export const COVERAGE_REASONS = {
  complete: 'Full history stored',
  noKey: 'No provider key for this exchange',
  quota: 'Daily quota used up, retries after reset',
  noData: 'Provider has no data for this symbol',
  retrying: 'Last attempt failed, retried automatically',
  notTried: 'Not tried yet',
  partial: 'Only part of the history is stored',
} as const;

/** What the history job last did for the symbol (the `ENRICH_STATE` item). `error` is sanitised and short. */
export interface CoverageAttempt {
  day: string;
  attempts: number;
  outcome: 'retry' | 'skipped';
  error: string;
}

/** The facts about the stored EOD rows of one symbol. */
export interface EodSummary {
  rows: number;
  first: string | null;
  last: string | null;
  /** Distinct sources; a row without one comes from a market-data provider. */
  sources: string[];
  /** The newest `MAX_COVERAGE_ROWS` were read and there are more: `rows` is a lower bound and `first` is not the oldest row. */
  capped: boolean;
}

export interface HeldSymbolCoverage {
  symbol: string;
  name: string;
  /** The market-data source that serves this kind of symbol (twelvedata, eodhd, coingecko). */
  provider: string;
  eodRows: number;
  eodRowsCapped: boolean;
  firstEod: string | null;
  lastEod: string | null;
  eodSources: string[];
  /** Date of the first transaction of the symbol. */
  firstTransaction: string;
  lastQuoteAt: string | null;
  lastQuoteSource: string | null;
  historyState: HistoryState;
  lastAttempt: CoverageAttempt | null;
  reason: string;
}

export interface CoverageTotals {
  /** Open positions, also when more than `MAX_COVERAGE_SYMBOLS` (then only that many are examined and `truncated` is true). */
  held: number;
  complete: number;
  partial: number;
  missing: number;
  /** The earliest day on which a symbol without history forces a valuation at cost; null when none does. */
  valuedAtCostSince: string | null;
  /** The first day on which every such symbol has a price (today for a symbol without any stored close). */
  valuedAtCostUntil: string | null;
  truncated: boolean;
}

/** `GET /prices/status` -> `history`. */
export interface PriceHistoryCoverage {
  asOf: string;
  symbols: HeldSymbolCoverage[];
  totals: CoverageTotals;
  /** EOD rows read to build this report (one query per symbol, each at most `MAX_COVERAGE_ROWS`). */
  rowsRead: number;
}

const DAY_MS = 86_400_000;
const byText = (a: string, b: string): number => a.localeCompare(b);

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** First day of the stretch that has to be covered: the first transaction, or a year before today when that is shorter. */
export function coverageWindowStart(firstTransaction: string, today: string): string {
  const yearAgo = shiftDay(today, -COVERAGE_WINDOW_DAYS);
  return firstTransaction > yearAgo ? firstTransaction : yearAgo;
}

const UNSOURCED = 'provider';

export function summarizeEod(rows: readonly Readonly<{ date: string; source?: string }>[], capped: boolean): EodSummary {
  const dates = rows.map((row) => row.date).sort(byText);
  const sources = [...new Set(rows.map((row) => row.source ?? UNSOURCED))].sort(byText);
  return { rows: rows.length, first: dates[0] ?? null, last: dates.at(-1) ?? null, sources, capped };
}

/** Whether the first row is late for the wanted range (the days before it have no price). */
function startsLate(first: string | null, windowStart: string): boolean {
  return first !== null && first > shiftDay(windowStart, COVERAGE_TOLERANCE_DAYS);
}

export function historyStateOf(eod: EodSummary, firstTransaction: string, today: string): HistoryState {
  if (eod.rows === 0 || eod.first === null || eod.last === null) return 'missing';
  const ends = eod.last >= shiftDay(today, -COVERAGE_TOLERANCE_DAYS);
  return ends && !startsLate(eod.first, coverageWindowStart(firstTransaction, today)) ? 'complete' : 'partial';
}

const URL_PATTERN = /https?:\/\/\S+/g;
const SECRET_PATTERN = /\b(?:api_?key|apikey|token|secret|key)=\S+/gi;
const LONG_TOKEN_PATTERN = /[A-Za-z0-9_-]{24,}/g;

/** The error text of an attempt as safe to show: no URL (it may carry a key), no long token, one line, at most 120 characters. */
export function sanitizeAttemptError(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const clean = raw.replaceAll(URL_PATTERN, '[url]').replaceAll(SECRET_PATTERN, '[redacted]').replaceAll(LONG_TOKEN_PATTERN, '[redacted]').split(/\s+/).filter(Boolean).join(' ');
  return clean.length <= MAX_ATTEMPT_ERROR_CHARS ? clean : `${clean.slice(0, MAX_ATTEMPT_ERROR_CHARS - 1)}…`;
}

const QUOTA_WORDS = /quota|limit|credit|too many|429/i;

export interface CoverageReasonInput {
  state: HistoryState;
  keyConfigured: boolean;
  providerBlocked: boolean;
  attempt: CoverageAttempt | null;
}

/** A short hint why the history is incomplete (or that it is not). */
export function coverageReason({ state, keyConfigured, providerBlocked, attempt }: Readonly<CoverageReasonInput>): string {
  if (state === 'complete') return COVERAGE_REASONS.complete;
  if (!keyConfigured) return COVERAGE_REASONS.noKey;
  if (attempt?.outcome === 'skipped') return COVERAGE_REASONS.noData;
  if (providerBlocked || (attempt !== null && QUOTA_WORDS.test(attempt.error))) return COVERAGE_REASONS.quota;
  if (attempt !== null) return COVERAGE_REASONS.retrying;
  return state === 'partial' ? COVERAGE_REASONS.partial : COVERAGE_REASONS.notTried;
}

export interface SymbolCoverageInput {
  symbol: string;
  name: string;
  provider: string;
  keyConfigured: boolean;
  providerBlocked: boolean;
  firstTransaction: string;
  eod: EodSummary;
  quote: Readonly<{ asOf: string; source: string }> | null;
  attempt: CoverageAttempt | null;
}

export function symbolCoverage(input: Readonly<SymbolCoverageInput>, today: string): HeldSymbolCoverage {
  const { eod, attempt } = input;
  const historyState = historyStateOf(eod, input.firstTransaction, today);
  return {
    symbol: input.symbol,
    name: input.name,
    provider: input.provider,
    eodRows: eod.rows,
    eodRowsCapped: eod.capped,
    firstEod: eod.first,
    lastEod: eod.last,
    eodSources: eod.sources,
    firstTransaction: input.firstTransaction,
    lastQuoteAt: input.quote?.asOf ?? null,
    lastQuoteSource: input.quote?.source || null,
    historyState,
    lastAttempt: attempt,
    reason: coverageReason({ state: historyState, keyConfigured: input.keyConfigured, providerBlocked: input.providerBlocked, attempt }),
  };
}

/** The days a symbol is valued at cost: from its first transaction until its first close (today when it has none), or null. */
function costWindow(row: Readonly<HeldSymbolCoverage>, today: string): { from: string; until: string } | null {
  if (row.historyState === 'missing') return { from: row.firstTransaction, until: today };
  if (row.firstEod === null || !startsLate(row.firstEod, coverageWindowStart(row.firstTransaction, today))) return null;
  return { from: row.firstTransaction, until: row.firstEod };
}

const STATE_ORDER: Readonly<Record<HistoryState, number>> = { missing: 0, partial: 1, complete: 2 };

/** Worst first, then by symbol: what needs attention is at the top. */
export function sortCoverage(rows: readonly HeldSymbolCoverage[]): HeldSymbolCoverage[] {
  return [...rows].sort((a, b) => STATE_ORDER[a.historyState] - STATE_ORDER[b.historyState] || byText(a.symbol, b.symbol));
}

export function coverageTotals(rows: readonly HeldSymbolCoverage[], held: number, today: string): CoverageTotals {
  const windows = rows.map((row) => costWindow(row, today)).filter((window) => window !== null);
  const count = (state: HistoryState): number => rows.filter((row) => row.historyState === state).length;
  const froms = windows.map((window) => window.from).sort(byText);
  const untils = windows.map((window) => window.until).sort(byText);
  return {
    held,
    complete: count('complete'),
    partial: count('partial'),
    missing: count('missing'),
    valuedAtCostSince: froms[0] ?? null,
    valuedAtCostUntil: untils.at(-1) ?? null,
    truncated: held > rows.length,
  };
}

/** What the chart says about the days it had to value at cost (`GetHistoryResponse.valuedAtCost`). */
export interface ValuedAtCost {
  /** Symbols without a stored close on some days of the range, sorted. */
  symbols: string[];
  /** Symbols held on at least one day of the range. */
  held: number;
  /** The first day on which every one of them has a price (the last day of the range at the latest). */
  until: string;
}

/** The note for a value series, or undefined when every day was valued with a price. `to` is the last day of the series. */
export function valuedAtCostOf(series: Readonly<Pick<ValueSeries, 'costValued' | 'held'>>, to: string): ValuedAtCost | undefined {
  if (series.costValued.length === 0) return undefined;
  const lastDay = series.costValued.map((span) => span.to).sort(byText).at(-1)!;
  const next = shiftDay(lastDay, 1);
  return {
    symbols: series.costValued.map((span) => span.symbol).sort(byText),
    held: series.held,
    until: next > to ? to : next,
  };
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int().nonnegative();

export const priceHistoryCoverageSchema = z.object({
  asOf: z.string(),
  symbols: z.array(
    z.object({
      symbol: z.string(),
      name: z.string(),
      provider: z.string(),
      eodRows: count,
      eodRowsCapped: z.boolean(),
      firstEod: day.nullable(),
      lastEod: day.nullable(),
      eodSources: z.array(z.string()),
      firstTransaction: day,
      lastQuoteAt: z.string().nullable(),
      lastQuoteSource: z.string().nullable(),
      historyState: z.enum(HISTORY_STATES),
      lastAttempt: z.object({ day, attempts: count, outcome: z.enum(['retry', 'skipped']), error: z.string() }).nullable(),
      reason: z.string(),
    }),
  ),
  totals: z.object({
    held: count,
    complete: count,
    partial: count,
    missing: count,
    valuedAtCostSince: day.nullable(),
    valuedAtCostUntil: day.nullable(),
    truncated: z.boolean(),
  }),
  rowsRead: count,
});

/** `GET /prices/status` as the web reads it: only the coverage section (absent on a Hub that predates it). */
export const pricesStatusHistorySchema = z.object({ history: priceHistoryCoverageSchema.nullish() });
