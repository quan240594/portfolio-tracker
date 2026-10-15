import type { DividendPayment, AnalyticsDividendGrowthResponse } from '@portfolio/shared';
import { formatMonth } from '../../lib/format';

export const PERIODS = [
  { value: 'all', label: 'All time' },
  { value: '12m', label: '12 months' },
  { value: 'ytd', label: 'YTD' },
] as const;
export type ReceivedPeriod = (typeof PERIODS)[number]['value'];

export const GRANULARITIES = [
  { value: 'month', label: 'Monthly' },
  { value: 'quarter', label: 'Quarterly' },
  { value: 'year', label: 'Yearly' },
] as const;
export type Granularity = (typeof GRANULARITIES)[number]['value'];

const MONTHS = 12;
const monthIndex = (date: string): number => Number(date.slice(0, 4)) * MONTHS + Number(date.slice(5, 7)) - 1;
const MONTHS_PER_BUCKET: Record<Granularity, number> = { month: 1, quarter: 3, year: 12 };
const bucketOf = (date: string, granularity: Granularity): number => Math.floor(monthIndex(date) / MONTHS_PER_BUCKET[granularity]);

function bucketLabel(bucket: number, granularity: Granularity): string {
  if (granularity === 'year') return String(bucket);
  if (granularity === 'quarter') return `Q${(bucket % 4) + 1} ${String(Math.floor(bucket / 4)).slice(2)}`;
  return formatMonth(`${Math.floor(bucket / MONTHS)}-${String((bucket % MONTHS) + 1).padStart(2, '0')}`);
}

/** First day (YYYY-MM-DD) of the period; null = from the first payment. */
function periodStart(period: ReceivedPeriod, today: string): string | null {
  if (period === 'ytd') return `${today.slice(0, 4)}-01-01`;
  if (period === '12m') {
    const index = monthIndex(today) - (MONTHS - 1);
    return `${Math.floor(index / MONTHS)}-${String((index % MONTHS) + 1).padStart(2, '0')}-01`;
  }
  return null;
}

/** Received payments inside the period that ends today. */
export function paymentsInPeriod(received: readonly DividendPayment[], period: ReceivedPeriod, today: string): DividendPayment[] {
  const start = periodStart(period, today);
  return received.filter((p) => p.date <= today && (start === null || p.date >= start));
}

export interface ReceivedBucket {
  label: string;
  amount: number;
}

/** Net dividends received per month/quarter/year over the period, without gaps between the first bucket and today's. */
export function receivedSeries(received: readonly DividendPayment[], period: ReceivedPeriod, granularity: Granularity, today: string): ReceivedBucket[] {
  const payments = paymentsInPeriod(received, period, today);
  let first = today;
  for (const p of payments) if (p.date < first) first = p.date;
  const start = periodStart(period, today) ?? first;
  const totals = new Map<number, number>();
  for (const p of payments) {
    const bucket = bucketOf(p.date, granularity);
    totals.set(bucket, (totals.get(bucket) ?? 0) + p.amount);
  }
  const from = bucketOf(start, granularity);
  const to = bucketOf(today, granularity);
  return Array.from({ length: to - from + 1 }, (_, i) => ({ label: bucketLabel(from + i, granularity), amount: Math.round((totals.get(from + i) ?? 0) * 100) / 100 }));
}

export interface HoldingTotal {
  symbol: string;
  amount: number;
}

/** Net dividends received per symbol over the period, largest first. */
export function receivedByHolding(received: readonly DividendPayment[], period: ReceivedPeriod, today: string): HoldingTotal[] {
  const totals = new Map<string, number>();
  for (const p of paymentsInPeriod(received, period, today)) totals.set(p.symbol, (totals.get(p.symbol) ?? 0) + p.amount);
  return [...totals.entries()]
    .map(([symbol, amount]) => ({ symbol, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount || a.symbol.localeCompare(b.symbol));
}

// --- Dividend growth by calendar month -----------------------------------------------------------------

export interface YearComparison {
  /** Years shown, oldest first. */
  years: string[];
  /** One row per calendar month (Jan…Dec); a year's value is missing for months without data (e.g. in the future). */
  rows: ({ month: string } & Record<string, number | string | undefined>)[];
}

const MONTH_NAMES = Array.from({ length: MONTHS }, (_, i) => new Intl.DateTimeFormat('nl-NL', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, i, 1))));

/** Dividends per calendar month for the latest `maxYears` years that have any, to compare them side by side. */
export function yearComparison(byMonth: AnalyticsDividendGrowthResponse['byMonth'], maxYears = 3): YearComparison {
  const years = [...new Set(byMonth.map((m) => m.month.slice(0, 4)))].sort((a, b) => a.localeCompare(b)).slice(-maxYears);
  const rows = MONTH_NAMES.map((month, i) => {
    const row: YearComparison['rows'][number] = { month };
    for (const m of byMonth) {
      if (Number(m.month.slice(5, 7)) - 1 === i && years.includes(m.month.slice(0, 4))) row[m.month.slice(0, 4)] = m.total;
    }
    return row;
  });
  return { years, rows };
}
