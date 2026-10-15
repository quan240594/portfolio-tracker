/**
 * Growth figures of the dividends received (net, base currency), shown under the "Dividend growth" chart: quarter over
 * quarter, year over year (rolling 12 months, calendar years as a fallback) and the all-time compound annual growth.
 * Pure: it only needs the net amount received per calendar month, the same totals the chart and its data table show.
 * Periods that are not complete yet (the current month, quarter and year) never take part.
 */
import { ratioToPct, roundTo } from './analytics.js';

const MONTHS = 12;
const MONTHS_PER_QUARTER = 3;
/** A rolling year-over-year comparison needs this many complete months of history (two 12-month periods). */
export const YOY_MIN_MONTHS = 2 * MONTHS;

export type DividendGrowthBasis = 'QUARTER' | 'TTM' | 'CALENDAR_YEAR';

export interface DividendGrowthPeriod {
  /** First and last month of the period, `YYYY-MM` (inclusive). */
  from: string;
  to: string;
  /** Net dividends received in the period, base currency. */
  amount: number;
}

export interface DividendPeriodGrowth {
  /** QUARTER: calendar quarters; TTM: rolling 12 complete months; CALENDAR_YEAR: calendar years (when there are fewer than 24 months). */
  basis: DividendGrowthBasis;
  current: DividendGrowthPeriod;
  previous: DividendGrowthPeriod;
  /** `current - previous`, base currency. */
  change: number;
  /** Percent change; null when `previous.amount` is not above zero (nothing to compare with). */
  pct: number | null;
}

export interface DividendCagrGrowth {
  startYear: number;
  endYear: number;
  startAmount: number;
  endAmount: number;
  /** `endYear - startYear` (at least 1). */
  years: number;
  /** `(end / start) ^ (1 / years) - 1`, percent. */
  pct: number;
}

export interface DividendGrowthStats {
  /** The day the periods are counted back from: the current month, quarter and year are left out. */
  asOf: string;
  /** Latest complete calendar quarter vs the one before; null without dividends up to the end of that quarter. */
  qoq: DividendPeriodGrowth | null;
  /** Last 12 complete months vs the 12 before (24+ months of history), else latest vs previous complete calendar year; null when neither is possible. */
  yoy: DividendPeriodGrowth | null;
  /** First vs latest complete calendar year; null with fewer than two complete years or without a positive first year. */
  cagr: DividendCagrGrowth | null;
}

/** Net amount received per month (`YYYY-MM`); months without payments may be absent. */
export type DividendMonthlyTotals = ReadonlyMap<string, number>;

const monthIndex = (month: string): number => Number(month.slice(0, 4)) * MONTHS + Number(month.slice(5, 7)) - 1;
const monthOf = (index: number): string => `${Math.floor(index / MONTHS)}-${String((index % MONTHS) + 1).padStart(2, '0')}`;

interface Range {
  from: number;
  to: number;
}

function sumRange(totals: ReadonlyMap<number, number>, { from, to }: Range): number {
  let amount = 0;
  for (const [index, total] of totals) if (index >= from && index <= to) amount += total;
  return amount;
}

const periodOf = ({ from, to }: Range, amount: number): DividendGrowthPeriod => ({ from: monthOf(from), to: monthOf(to), amount: roundTo(amount) });

function compare(totals: ReadonlyMap<number, number>, basis: DividendGrowthBasis, current: Range, previous: Range): DividendPeriodGrowth {
  const cur = sumRange(totals, current);
  const prev = sumRange(totals, previous);
  return {
    basis,
    current: periodOf(current, cur),
    previous: periodOf(previous, prev),
    change: roundTo(cur - prev),
    pct: prev > 0 ? ratioToPct(cur / prev - 1) : null,
  };
}

/** The `length` months ending at `end`, and the same number of months right before them. */
const rangesEndingAt = (end: number, length: number): [Range, Range] => [
  { from: end - length + 1, to: end },
  { from: end - 2 * length + 1, to: end - length },
];

function quarterOverQuarter(totals: ReadonlyMap<number, number>, first: number, currentMonth: number): DividendPeriodGrowth | null {
  const endOfLatest = Math.floor(currentMonth / MONTHS_PER_QUARTER) * MONTHS_PER_QUARTER - 1;
  if (first > endOfLatest) return null;
  const [latest, previous] = rangesEndingAt(endOfLatest, MONTHS_PER_QUARTER);
  return compare(totals, 'QUARTER', latest, previous);
}

function yearOverYear(totals: ReadonlyMap<number, number>, first: number, currentMonth: number): DividendPeriodGrowth | null {
  const lastComplete = currentMonth - 1;
  if (lastComplete - first + 1 >= YOY_MIN_MONTHS) {
    const [latest, previous] = rangesEndingAt(lastComplete, MONTHS);
    return compare(totals, 'TTM', latest, previous);
  }
  const endOfLatestYear = Math.floor(currentMonth / MONTHS) * MONTHS - 1;
  const [latest, previous] = rangesEndingAt(endOfLatestYear, MONTHS);
  const growth = compare(totals, 'CALENDAR_YEAR', latest, previous);
  return growth.pct === null ? null : growth;
}

function compoundGrowth(totals: ReadonlyMap<number, number>, currentMonth: number): DividendCagrGrowth | null {
  const yearly = new Map<number, number>();
  for (const [index, total] of totals) {
    const year = Math.floor(index / MONTHS);
    yearly.set(year, (yearly.get(year) ?? 0) + total);
  }
  const startYear = Math.min(...yearly.keys());
  const endYear = Math.floor(currentMonth / MONTHS) - 1;
  const years = endYear - startYear;
  const start = yearly.get(startYear)!;
  const end = yearly.get(endYear) ?? 0;
  if (years < 1 || start <= 0 || end < 0) return null;
  return { startYear, endYear, startAmount: roundTo(start), endAmount: roundTo(end), years, pct: ratioToPct((end / start) ** (1 / years) - 1) };
}

/**
 * Quarter-over-quarter, year-over-year and compound annual growth of the dividends received.
 * `today` is `YYYY-MM-DD`; payments in or after the current month are ignored. The monthly totals are used as given: pass the
 * (cent-rounded) values the chart shows and every period amount is the sum of the bars/rows it covers, so the figures can be
 * reproduced from the data table. Percentages are rounded to two decimals only on output.
 */
export function calculateDividendGrowthStats(monthlyTotals: DividendMonthlyTotals, today: string): DividendGrowthStats {
  const currentMonth = monthIndex(today.slice(0, 7));
  const totals = new Map<number, number>();
  for (const [month, total] of monthlyTotals) if (monthIndex(month) < currentMonth) totals.set(monthIndex(month), total);
  const empty: DividendGrowthStats = { asOf: today, qoq: null, yoy: null, cagr: null };
  if (totals.size === 0) return empty;
  const first = Math.min(...totals.keys());
  return {
    asOf: today,
    qoq: quarterOverQuarter(totals, first, currentMonth),
    yoy: yearOverYear(totals, first, currentMonth),
    cagr: compoundGrowth(totals, currentMonth),
  };
}
