/**
 * Chart reconciliation (`GET /diagnostics/valuation`): how the value line of the dashboard chart is made up on a day, per held symbol.
 * The valuation is the chart's own (`buildValueSeries` with its `onPosition` hook), so the lines add up to the chart point; each
 * line is compared with a "fair" value (the close as stored x units x the fixing of that day) so a distortion (a position valued
 * at cost, a close of another currency or unit, an FX rate that is not that day's) is the largest gap at the top.
 */
import { z } from 'zod';
import { FxTimeline } from './fx.js';
import { buildValueSeries, dropDuplicateSplits, sortTransactions, type ValueHistoryExtra, type ValuationSource, type ValuedPosition } from './portfolio.js';
import { portfolioScopeSchema } from './schemas.js';
import type { EodPrice, FxDay, FxRates, Quote, Transaction } from './types.js';

export const VALUATION_ROUTES = {
  valuationReport: 'GET /diagnostics/valuation',
} as const;

/** Symbols examined per report; the others only count in `symbolsTotal`. */
export const MAX_VALUATION_SYMBOLS = 60;
export const MAX_VALUATION_DATES = 3;
/** Days before today of the third default date: about six months back. */
export const DEFAULT_PAST_DAYS = 182;
/** A close older than this many days (a long weekend plus a holiday) is flagged `stale`. */
export const STALE_CLOSE_DAYS = 7;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `?dates=YYYY-MM-DD,YYYY-MM-DD` (at most {@link MAX_VALUATION_DATES}); omitted = today, yesterday and about six months back. */
export const valuationQuerySchema = portfolioScopeSchema.extend({
  dates: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return undefined;
      const parts = [...new Set(raw.split(',').map((part) => part.trim()).filter((part) => part !== ''))];
      if (parts.length > MAX_VALUATION_DATES || parts.some((part) => !day.safeParse(part).success)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `dates must be at most ${MAX_VALUATION_DATES} comma separated YYYY-MM-DD days` });
        return z.NEVER;
      }
      return parts;
    }),
});

export type ValuationFlag = 'carried' | 'stale' | 'cost' | 'currency' | 'scale' | 'fx';

export interface ValuationLine {
  symbol: string;
  /** Units on that day (today's share basis). */
  units: number;
  /** Currency the position is held in. */
  currency: string;
  /** The price used per unit, the currency of that price and the day of the close (null: average cost). */
  price: number;
  priceCurrency: string;
  priceDate: string | null;
  /** Days between the day and the close used; null for the average cost. */
  ageDays: number | null;
  source: ValuationSource;
  /** Units of the price currency per 1 base, the fixing it comes from (null: the latest rate) and whether it is that day's. */
  fxRate: number;
  fxDate: string | null;
  fxFallback: 'none' | 'before' | 'after' | 'latest';
  /** What the chart counts for the position, the fair value, their difference, and the value of the same symbol on the last day. */
  value: number;
  fair: number;
  gap: number;
  today: number | null;
  flags: ValuationFlag[];
}

export interface ValuationDay {
  date: string;
  /** The chart point: the positions plus cash and custom assets. */
  chartValue: number;
  positionsValue: number;
  /** Cash and custom assets (chart value - positions). */
  extraValue: number;
  invested: number;
  fairValue: number;
  /** Positions' value - fair value. */
  gap: number;
  /** Lines, the largest absolute gap first. */
  lines: ValuationLine[];
}

export interface FxCoverageRow {
  currency: string;
  /** Stored fixings and the first and last of them; zero and null when there is no history for the currency. */
  fixings: number;
  first: string | null;
  last: string | null;
  /** Days between the first transaction and today on which the rate is not that day's fixing (before the history, long after it, or the latest rate). */
  fallbackDays: number;
}

export interface ValuationReport {
  asOf: string;
  baseCurrency: string;
  /** The headline total of today (what the dashboard shows), or null when it could not be computed. */
  headline: number | null;
  days: ValuationDay[];
  fx: FxCoverageRow[];
  symbolsTotal: number;
  /** More symbols are held than examined: the totals leave the others out. */
  truncated: boolean;
  /** Rows read to build the report. */
  rowsRead: number;
}

export interface ValuationReportInput {
  transactions: readonly Transaction[];
  /** The closes as the chart reads them (see `alignEodScale`) and as they are stored. */
  eod: Readonly<Record<string, readonly EodPrice[]>>;
  storedEod: Readonly<Record<string, readonly EodPrice[]>>;
  fx: FxRates;
  fxHistory?: readonly FxDay[];
  quotes: Readonly<Record<string, Quote>>;
  extra?: ValueHistoryExtra;
  today: string;
  dates: readonly string[];
  headline: number | null;
  symbolsTotal: number;
  rowsRead: number;
}

const DAY_MS = 86_400_000;
const round = (n: number, dp = 2): number => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const shiftDay = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The days of a report: today, yesterday and about six months back unless `requested`; never after today, oldest first, at most three. */
export function reportDates(requested: readonly string[] | undefined, today: string): string[] {
  const wanted = requested ?? [today, shiftDay(today, -1), shiftDay(today, -DEFAULT_PAST_DAYS)];
  return [...new Set(wanted.filter((date) => date <= today))].sort((a, b) => a.localeCompare(b)).slice(0, MAX_VALUATION_DATES);
}

/** The newest stored close on or before `date`. */
function storedCloseOn(rows: readonly EodPrice[] | undefined, date: string): EodPrice | undefined {
  let found: EodPrice | undefined;
  for (const row of rows ?? []) if (row.date <= date && (found === undefined || row.date > found.date)) found = row;
  return found;
}

interface FairInput {
  line: ValuedPosition;
  stored: EodPrice | undefined;
  quote: Quote | undefined;
  timeline: FxTimeline;
}

/** The value the symbol should have: units x the stored close (or, without one, the live quote) x the fixing of the day; the line's own value when neither exists. */
function fairValue({ line, stored, quote, timeline }: Readonly<FairInput>): number {
  if (stored !== undefined) return (line.units * stored.close) / timeline.rate(stored.currency, line.date);
  if (quote !== undefined) return (line.units * quote.price) / timeline.rate(quote.currency, line.date);
  return line.value;
}

function flagsOf(line: ValuedPosition, stored: EodPrice | undefined, ageDays: number | null): ValuationFlag[] {
  const flags: ValuationFlag[] = [];
  if (line.source === 'carried') flags.push('carried');
  if (ageDays !== null && ageDays > STALE_CLOSE_DAYS && line.source !== 'quote') flags.push('stale');
  if (line.source === 'cost') flags.push('cost');
  if (line.priceCurrency !== line.currency) flags.push('currency');
  if (stored?.date === line.priceDate && (stored.close !== line.price || stored.currency !== line.priceCurrency)) flags.push('scale');
  if (line.fx.fallback !== 'none') flags.push('fx');
  return flags;
}

function toLine(line: ValuedPosition, input: Readonly<ValuationReportInput>, timeline: FxTimeline, todayValue: number | null): ValuationLine {
  const stored = line.source === 'quote' || line.source === 'cost' ? undefined : storedCloseOn(input.storedEod[line.symbol], line.date);
  const fair = fairValue({ line, stored, quote: input.quotes[line.symbol], timeline });
  const ageDays = line.priceDate === null || line.source === 'quote' ? null : daysBetween(line.priceDate, line.date);
  return {
    symbol: line.symbol,
    units: round(line.units, 6),
    currency: line.currency,
    price: round(line.price, 4),
    priceCurrency: line.priceCurrency,
    priceDate: line.priceDate,
    ageDays,
    source: line.source,
    fxRate: round(line.fx.rate, 6),
    fxDate: line.fx.date,
    fxFallback: line.fx.fallback,
    value: round(line.value),
    fair: round(fair),
    gap: round(line.value - fair),
    today: todayValue === null ? null : round(todayValue),
    flags: flagsOf(line, stored, ageDays),
  };
}

const byGap = (a: ValuationLine, b: ValuationLine): number => Math.abs(b.gap) - Math.abs(a.gap) || a.symbol.localeCompare(b.symbol);

/** Per currency of the held lines: the stored fixings and the days (since the first transaction) that use another day's rate. */
function fxCoverage(timeline: FxTimeline, currencies: ReadonlySet<string>, first: string, today: string): FxCoverageRow[] {
  return [...currencies]
    .filter((currency) => currency !== timeline.base)
    .sort((a, b) => a.localeCompare(b))
    .map((currency) => {
      const span = timeline.span(currency);
      let fallbackDays = 0;
      for (let date = first; date <= today; date = shiftDay(date, 1)) if (timeline.lookup(currency, date).fallback !== 'none') fallbackDays++;
      return { currency, fixings: span?.fixings ?? 0, first: span?.first ?? null, last: span?.last ?? null, fallbackDays };
    });
}

/** The reconciliation of the chart on the requested days (a single pass over the days from the oldest to today). */
export function buildValuationReport(input: Readonly<ValuationReportInput>): ValuationReport {
  const { today, fx, fxHistory } = input;
  const dates = reportDates(input.dates, today);
  const sorted = dropDuplicateSplits(sortTransactions(input.transactions));
  const timeline = new FxTimeline(fx, fxHistory);
  const wanted = new Set([...dates, today]);
  const lines = new Map<string, ValuedPosition[]>();
  const currencies = new Set<string>();
  const { points: series } = buildValueSeries({
    transactions: input.transactions,
    eod: input.eod,
    fx,
    from: dates[0] ?? today,
    to: today,
    fxHistory,
    extra: input.extra,
    quotes: input.quotes,
    onPosition: (line) => {
      currencies.add(line.priceCurrency);
      if (wanted.has(line.date)) lines.set(line.date, [...(lines.get(line.date) ?? []), line]);
    },
  });
  const points = new Map(series.map((point) => [point.date, point]));
  const todayValues = new Map((lines.get(today) ?? []).map((line) => [line.symbol, line.value]));
  const days = dates.flatMap((date): ValuationDay[] => {
    const point = points.get(date);
    if (point === undefined) return [];
    const valued = (lines.get(date) ?? []).map((line) => toLine(line, input, timeline, todayValues.get(line.symbol) ?? null)).sort(byGap);
    const positionsValue = valued.reduce((sum, line) => sum + line.value, 0);
    const fair = valued.reduce((sum, line) => sum + line.fair, 0);
    return [{ date, chartValue: point.value, positionsValue: round(positionsValue), extraValue: round(point.value - positionsValue), invested: point.invested, fairValue: round(fair), gap: round(positionsValue - fair), lines: valued }];
  });
  return {
    asOf: `${today}T00:00:00.000Z`,
    baseCurrency: fx.base,
    headline: input.headline,
    days,
    fx: fxCoverage(timeline, currencies, sorted[0]?.date ?? today, today),
    symbolsTotal: input.symbolsTotal,
    truncated: input.symbolsTotal > MAX_VALUATION_SYMBOLS,
    rowsRead: input.rowsRead,
  };
}

const lineSchema = z.object({
  symbol: z.string(),
  units: z.number(),
  currency: z.string(),
  price: z.number(),
  priceCurrency: z.string(),
  priceDate: day.nullable(),
  ageDays: z.number().nullable(),
  source: z.enum(['close', 'carried', 'quote', 'cost']),
  fxRate: z.number(),
  fxDate: day.nullable(),
  fxFallback: z.enum(['none', 'before', 'after', 'latest']),
  value: z.number(),
  fair: z.number(),
  gap: z.number(),
  today: z.number().nullable(),
  flags: z.array(z.enum(['carried', 'stale', 'cost', 'currency', 'scale', 'fx'])),
});

export const valuationReportSchema = z.object({
  asOf: z.string(),
  baseCurrency: z.string(),
  headline: z.number().nullable(),
  days: z.array(
    z.object({
      date: day,
      chartValue: z.number(),
      positionsValue: z.number(),
      extraValue: z.number(),
      invested: z.number(),
      fairValue: z.number(),
      gap: z.number(),
      lines: z.array(lineSchema),
    }),
  ),
  fx: z.array(z.object({ currency: z.string(), fixings: z.number(), first: day.nullable(), last: day.nullable(), fallbackDays: z.number() })),
  symbolsTotal: z.number(),
  truncated: z.boolean(),
  rowsRead: z.number(),
});

export type GetValuationReportResponse = z.infer<typeof valuationReportSchema>;
