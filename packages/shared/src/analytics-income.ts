/** Passive-income forecast and dividend growth, derived from DIVIDEND transactions and announced events. */
import { FxTimeline } from './fx.js';
import { addIsoDays, daysBetween, DAYS_PER_YEAR, ratioToPct, roundTo, transactionAmount } from './analytics.js';
import type { DividendEvent, Holding, Transaction } from './types.js';

// --- Passive income --------------------------------------------------------------------------------

export interface PassiveIncomeHolding {
  symbol: string;
  name: string;
  declared: number;
  estimated: number;
  total: number;
  /** Share of the portfolio's forward income, percent. */
  sharePct: number;
  /** Forward income / market value, percent. */
  yieldPct: number;
  /** Forward income / cost basis, percent. */
  yieldOnCostPct: number;
}

export interface PassiveIncome {
  baseCurrency: string;
  /** Net income expected over the next 12 months (declared + estimated). */
  forward12m: number;
  declared: number;
  estimated: number;
  yieldOnValuePct: number;
  yieldOnCostPct: number;
  /** Holdings with expected income, largest first. */
  holdings: PassiveIncomeHolding[];
}

interface PaymentDay {
  date: string;
  perShare: number;
  gross: number;
  withheld: number;
}

/** Dividend payments of one symbol grouped per day, oldest first. */
function paymentDays(transactions: readonly Transaction[], symbol: string): PaymentDay[] {
  const byDate = new Map<string, PaymentDay>();
  for (const t of transactions) {
    if (t.type !== 'DIVIDEND' || t.symbol !== symbol) continue;
    const day = byDate.get(t.date) ?? { date: t.date, perShare: 0, gross: 0, withheld: 0 };
    day.perShare += t.price;
    day.gross += t.quantity * t.price;
    day.withheld += t.fee;
    byDate.set(t.date, day);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Payments per year implied by the median gap between the last payments (1, 2, 4 or 12). */
export function paymentsPerYear(dates: readonly string[]): number {
  const recent = dates.slice(-5);
  if (recent.length < 2) return 1;
  const gaps = recent.slice(1).map((d, i) => daysBetween(recent[i]!, d)).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  if (median <= 45) return 12;
  if (median <= 135) return 4;
  return median <= 270 ? 2 : 1;
}

interface SymbolIncome {
  declared: number;
  estimated: number;
}

function symbolIncome(
  holding: Holding,
  transactions: readonly Transaction[],
  events: readonly DividendEvent[],
  timeline: FxTimeline,
  today: string,
): SymbolIncome {
  const horizon = addIsoDays(today, DAYS_PER_YEAR);
  const upcoming = events.filter((e) => e.symbol === holding.symbol && e.exDate > today && e.exDate <= horizon);
  const days = paymentDays(transactions, holding.symbol);
  const trailing = days.filter((d) => d.date > addIsoDays(today, -DAYS_PER_YEAR) && d.date <= today);
  const grossPaid = trailing.reduce((s, d) => s + d.gross, 0);
  const withholding = grossPaid > 0 ? trailing.reduce((s, d) => s + d.withheld, 0) / grossPaid : 0;
  const net = Math.max(0, 1 - withholding);

  const declaredGross = upcoming.reduce((s, e) => s + timeline.toBase(holding.quantity * e.amount, e.currency), 0);
  // Estimate only for payers that paid within the last year; assume the same schedule and the latest amount.
  const latest = days.at(-1);
  const missing = trailing.length > 0 && latest ? Math.max(0, paymentsPerYear(days.map((d) => d.date)) - upcoming.length) : 0;
  const estimatedGross = latest ? missing * timeline.toBase(holding.quantity * latest.perShare, holding.currency) : 0;
  return { declared: declaredGross * net, estimated: estimatedGross * net };
}

/**
 * Forward 12-month net dividend income per current holding. Declared = announced events with an ex-date in
 * the next 12 months × quantity held (latest FX). Estimated = the payments a holding's history implies
 * (frequency from the gaps between its last payments) that are not yet announced, valued at its latest
 * per-share amount. Both are reduced by the withholding tax observed in the last 12 months.
 */
export function calculatePassiveIncome(
  holdings: readonly Holding[],
  transactions: readonly Transaction[],
  events: readonly DividendEvent[],
  timeline: FxTimeline,
  today: string,
): PassiveIncome {
  const rows = holdings.map((h) => ({ h, ...symbolIncome(h, transactions, events, timeline, today) }));
  const declared = rows.reduce((s, r) => s + r.declared, 0);
  const estimated = rows.reduce((s, r) => s + r.estimated, 0);
  const forward = declared + estimated;
  const value = holdings.reduce((s, h) => s + h.marketValue, 0);
  const cost = holdings.reduce((s, h) => s + h.costBasis, 0);
  const ratio = (num: number, den: number) => (den > 0 ? ratioToPct(num / den) : 0);

  return {
    baseCurrency: timeline.base,
    forward12m: roundTo(forward),
    declared: roundTo(declared),
    estimated: roundTo(estimated),
    yieldOnValuePct: ratio(forward, value),
    yieldOnCostPct: ratio(forward, cost),
    holdings: rows
      .filter((r) => r.declared + r.estimated > 0)
      .map((r) => ({
        symbol: r.h.symbol,
        name: r.h.name,
        declared: roundTo(r.declared),
        estimated: roundTo(r.estimated),
        total: roundTo(r.declared + r.estimated),
        sharePct: ratio(r.declared + r.estimated, forward),
        yieldPct: ratio(r.declared + r.estimated, r.h.marketValue),
        yieldOnCostPct: ratio(r.declared + r.estimated, r.h.costBasis),
      }))
      .sort((a, b) => b.total - a.total || a.symbol.localeCompare(b.symbol)),
  };
}

// --- Dividend growth -------------------------------------------------------------------------------

export interface DividendYear {
  year: string;
  /** Net dividends received in the base currency. */
  total: number;
  payments: number;
  /** Growth vs the previous calendar year, percent; null without a previous year. */
  yoyPct: number | null;
  /** The year is still running, so the total (and growth) is incomplete. */
  partial: boolean;
}

export interface DividendMonth {
  month: string;
  total: number;
  /** Same month one year earlier. */
  previousYearTotal: number;
  yoyPct: number | null;
}

export interface DividendPerShareYear {
  year: string;
  /** Sum of the per-share amounts paid in the year (instrument currency). */
  perShare: number;
  yoyPct: number | null;
  partial: boolean;
}

export interface DividendPerShareSeries {
  symbol: string;
  currency: string;
  years: DividendPerShareYear[];
}

export interface DividendGrowth {
  baseCurrency: string;
  byYear: DividendYear[];
  /** Every month from the first to the last payment (gaps filled with 0). */
  byMonth: DividendMonth[];
  perShare: DividendPerShareSeries[];
}

const growthPct = (current: number, previous: number | undefined): number | null =>
  previous !== undefined && previous > 0 ? ratioToPct(current / previous - 1) : null;

const previousYear = (year: string): string => String(Number(year) - 1);
const previousYearMonth = (month: string): string => `${previousYear(month.slice(0, 4))}${month.slice(4)}`;

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

const sumInto = (map: Map<string, number>, key: string, amount: number) => map.set(key, (map.get(key) ?? 0) + amount);

function monthRows(totals: ReadonlyMap<string, number>): DividendMonth[] {
  const months = [...totals.keys()].sort((a, b) => a.localeCompare(b));
  const first = months[0];
  if (!first) return [];
  const out: DividendMonth[] = [];
  for (let m = first; m <= months.at(-1)!; m = nextMonth(m)) {
    const total = totals.get(m) ?? 0;
    const previous = totals.get(previousYearMonth(m));
    out.push({ month: m, total: roundTo(total), previousYearTotal: roundTo(previous ?? 0), yoyPct: growthPct(total, previous) });
  }
  return out;
}

function perShareSeries(transactions: readonly Transaction[], currentYear: string): DividendPerShareSeries[] {
  const bySymbol = new Map<string, { currency: string; years: Map<string, number> }>();
  for (const t of transactions) {
    if (t.type !== 'DIVIDEND') continue;
    const entry = bySymbol.get(t.symbol) ?? { currency: t.currency, years: new Map<string, number>() };
    sumInto(entry.years, t.date.slice(0, 4), t.price);
    bySymbol.set(t.symbol, entry);
  }
  return [...bySymbol.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, { currency, years }]) => ({
      symbol,
      currency,
      years: [...years.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([year, perShare]) => ({ year, perShare: roundTo(perShare, 4), yoyPct: growthPct(perShare, years.get(previousYear(year))), partial: year === currentYear })),
    }));
}

/** Year-over-year dividend growth (net, base currency) by year and by month, plus per-share growth per symbol. */
export function calculateDividendGrowth(transactions: readonly Transaction[], timeline: FxTimeline, today: string): DividendGrowth {
  const dividends = transactions.filter((t) => t.type === 'DIVIDEND');
  const yearTotals = new Map<string, number>();
  const yearCounts = new Map<string, number>();
  const monthTotals = new Map<string, number>();
  for (const t of dividends) {
    const amount = transactionAmount(t, timeline);
    sumInto(yearTotals, t.date.slice(0, 4), amount);
    sumInto(yearCounts, t.date.slice(0, 4), 1);
    sumInto(monthTotals, t.date.slice(0, 7), amount);
  }
  const currentYear = today.slice(0, 4);
  return {
    baseCurrency: timeline.base,
    byYear: [...yearTotals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([year, total]) => ({
        year,
        total: roundTo(total),
        payments: yearCounts.get(year)!,
        yoyPct: growthPct(total, yearTotals.get(previousYear(year))),
        partial: year === currentYear,
      })),
    byMonth: monthRows(monthTotals),
    perShare: perShareSeries(dividends, currentYear),
  };
}
