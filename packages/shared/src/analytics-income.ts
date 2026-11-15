/** Passive-income forecast and dividend growth, derived from DIVIDEND transactions and announced events. */
import { FxTimeline } from './fx.js';
import { deriveRunRate, observedNetFactor, type RunRate, type RunRateBasis } from './dividend-run-rate.js';
import { addIsoDays, DAYS_PER_YEAR, ratioToPct, roundTo, transactionAmount } from './analytics.js';
import { calculateDividendGrowthStats, type DividendGrowthStats } from './dividend-growth-stats.js';
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
  /** Forward income before withholding tax / market value, percent: the figure broker apps quote. */
  grossYieldPct: number;
  /** Withholding tax assumed on the forward income, percent (observed on your last 12 months of dividends). */
  withholdingPct: number;
  /** What the estimate rests on, see `RunRateBasis`. */
  basis: RunRateBasis;
  /** Payments a year the forward income assumes (1, 2, 4 or 12). */
  paymentsPerYear: number;
  /** Regular dividend per share and year the forward income assumes (`perShare` × `paymentsPerYear`), in the paying currency. */
  perShareAnnual: number;
}

export interface PassiveIncome {
  baseCurrency: string;
  /** Net income expected over the next 12 months (declared + estimated). */
  forward12m: number;
  declared: number;
  estimated: number;
  yieldOnValuePct: number;
  yieldOnCostPct: number;
  /** Forward income before withholding tax / market value, percent. */
  grossYieldOnValuePct: number;
  /** Holdings with expected income, largest first. */
  holdings: PassiveIncomeHolding[];
}

interface PaymentDay {
  date: string;
  perShare: number;
}

/** Dividend payments of one symbol grouped per day (per-share amounts added up), oldest first. */
function paymentDays(transactions: readonly Transaction[], symbol: string): PaymentDay[] {
  const byDate = new Map<string, number>();
  for (const t of transactions) {
    if (t.type === 'DIVIDEND' && t.symbol === symbol) byDate.set(t.date, (byDate.get(t.date) ?? 0) + t.price);
  }
  return [...byDate.entries()].map(([date, perShare]) => ({ date, perShare })).sort((a, b) => a.date.localeCompare(b.date));
}

interface SymbolIncome {
  declared: number;
  estimated: number;
  /** The same amounts before withholding tax. */
  declaredGross: number;
  estimatedGross: number;
  rate: RunRate;
  /** Share of a gross dividend that reaches you (1 = nothing withheld). */
  net: number;
  basis: RunRateBasis;
}

function basisOf(rate: RunRate, declaredGross: number, estimatedGross: number): RunRateBasis {
  const evidenced = rate.basis === 'provider-history' || rate.basis === 'own-payments';
  return evidenced && estimatedGross <= 0 && declaredGross > 0 ? 'declared' : rate.basis;
}

function symbolIncome(
  holding: Holding,
  transactions: readonly Transaction[],
  trailing: readonly Transaction[],
  events: readonly DividendEvent[],
  timeline: FxTimeline,
  today: string,
): SymbolIncome {
  const horizon = addIsoDays(today, DAYS_PER_YEAR);
  const own = events.filter((e) => e.symbol === holding.symbol);
  const upcoming = own.filter((e) => e.exDate > today && e.exDate <= horizon);
  const rate = deriveRunRate({ currency: holding.currency, events: own, payments: paymentDays(transactions, holding.symbol), timeline, today });
  const net = observedNetFactor(trailing, holding.symbol, holding.currency);

  const declaredGross = upcoming.reduce((s, e) => s + timeline.toBase(holding.quantity * e.amount, e.currency), 0);
  // The rest of the year's payments follow the run rate; a declared special dividend is not one of the regular payments.
  const regularUpcoming = upcoming.filter((e) => !rate.specialExDates.has(e.exDate)).length;
  const missing = rate.basis === 'none' ? 0 : Math.max(0, rate.paymentsPerYear - regularUpcoming);
  const estimatedGross = missing * timeline.toBase(holding.quantity * rate.perShare, holding.currency);
  return { declared: declaredGross * net, estimated: estimatedGross * net, declaredGross, estimatedGross, rate, net, basis: basisOf(rate, declaredGross, estimatedGross) };
}

/**
 * Forward 12-month net dividend income per current holding. Declared = announced events with an ex-date in
 * the next 12 months × quantity held (latest FX). Estimated = the regular payments of those 12 months that are not
 * yet announced, valued at the holding's latest regular per-share amount: how many comes from the symbol's run rate
 * (see `deriveRunRate`: the provider's dividend history first, then your own payments). Both are reduced by the
 * withholding tax observed on your dividends of the last 12 months.
 */
export function calculatePassiveIncome(
  holdings: readonly Holding[],
  transactions: readonly Transaction[],
  events: readonly DividendEvent[],
  timeline: FxTimeline,
  today: string,
): PassiveIncome {
  return passiveIncomeWithRates(holdings, transactions, events, timeline, today).income;
}

/** `calculatePassiveIncome` plus the run rate of every holding (by symbol), which the Dividends page schedules the estimated payments with. */
export function passiveIncomeWithRates(
  holdings: readonly Holding[],
  transactions: readonly Transaction[],
  events: readonly DividendEvent[],
  timeline: FxTimeline,
  today: string,
): { income: PassiveIncome; rates: ReadonlyMap<string, RunRate> } {
  const since = addIsoDays(today, -DAYS_PER_YEAR);
  const trailing = transactions.filter((t) => t.type === 'DIVIDEND' && t.date > since && t.date <= today);
  const rows = holdings.map((h) => ({ h, ...symbolIncome(h, transactions, trailing, events, timeline, today) }));
  const declared = rows.reduce((s, r) => s + r.declared, 0);
  const estimated = rows.reduce((s, r) => s + r.estimated, 0);
  const forward = declared + estimated;
  const gross = rows.reduce((s, r) => s + r.declaredGross + r.estimatedGross, 0);
  const value = holdings.reduce((s, h) => s + h.marketValue, 0);
  const cost = holdings.reduce((s, h) => s + h.costBasis, 0);
  const ratio = (num: number, den: number) => (den > 0 ? ratioToPct(num / den) : 0);

  const income: PassiveIncome = {
    baseCurrency: timeline.base,
    forward12m: roundTo(forward),
    declared: roundTo(declared),
    estimated: roundTo(estimated),
    yieldOnValuePct: ratio(forward, value),
    yieldOnCostPct: ratio(forward, cost),
    grossYieldOnValuePct: ratio(gross, value),
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
        grossYieldPct: ratio(r.declaredGross + r.estimatedGross, r.h.marketValue),
        withholdingPct: roundTo((1 - r.net) * 100, 1),
        basis: r.basis,
        paymentsPerYear: r.rate.paymentsPerYear,
        perShareAnnual: roundTo(r.rate.perShare * r.rate.paymentsPerYear, 4),
      }))
      .sort((a, b) => b.total - a.total || a.symbol.localeCompare(b.symbol)),
  };
  return { income, rates: new Map(rows.map((r) => [r.h.symbol, r.rate])) };
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
  /** QoQ, YoY and CAGR of the net amounts in `byMonth`; absent in responses of older servers. */
  growthStats?: DividendGrowthStats;
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
  const byMonth = monthRows(monthTotals);
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
    byMonth,
    perShare: perShareSeries(dividends, currentYear),
    growthStats: calculateDividendGrowthStats(new Map(byMonth.map((m) => [m.month, m.total])), today),
  };
}
