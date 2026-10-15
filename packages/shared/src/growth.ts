/**
 * Growth view calculations: value and return series of the portfolio next to several benchmarks replayed with the same
 * cash flows, monthly returns, the "ahead of / behind" headline and the return per holding. Everything reuses the pure
 * building blocks of the other analytics (value history, daily flows, TWR chaining, benchmark replay), so the Lambda and
 * the web demo's mock backend produce identical numbers.
 */
import {
  addIsoDays,
  chainReturns,
  dailyFlows,
  downsampleEvenly,
  periodKey,
  portfolioDailyReturns,
  ratioToPct,
  roundTo,
  type DailyReturn,
  type DayFlows,
  type ReturnPeriod,
} from './analytics.js';
import type { BenchmarkComparison } from './analytics-api.js';
import {
  MAX_ANALYTICS_POINTS,
  NO_TRANSACTIONS_MESSAGE,
  benchmarkPrices,
  buildContext,
  compare,
  noBenchmarkMessage,
  priceReturns,
  replay,
  type AnalyticsData,
  type Context,
} from './analytics-compute.js';
import {
  BENCHMARK_SUGGESTIONS,
  type AnalyticsGrowthResponse,
  type AnalyticsHoldingsPerformanceResponse,
  type GrowthBenchmark,
  type GrowthBenchmarkOption,
  type GrowthHeadline,
  type GrowthMonthRow,
  type GrowthPeriod,
  type GrowthPoint,
  type GrowthRange,
  type HoldingPerformanceRow,
} from './growth-api.js';
import { buildValueHistory, calculatePortfolio, historyRangeStart, sortTransactions } from './portfolio.js';
import type { Transaction, ValuePoint } from './types.js';

/** Days in the "5Y" range (five years incl. one leap day). */
const FIVE_YEARS_DAYS = 1826;

/** First day of a range, never before the first investment (`firstDate`). */
export function growthRangeStart(range: GrowthRange, today: string, firstDate: string): string {
  let start: string;
  if (range === '7D') start = addIsoDays(today, -7);
  else if (range === '5Y') start = addIsoDays(today, -FIVE_YEARS_DAYS);
  else start = historyRangeStart(range, today, firstDate);
  return start > firstDate ? start : firstDate;
}

/**
 * Cumulative time-weighted return in percent at each of `dates` (ascending, `dates[0]` is the base: 0), chaining the
 * daily returns that fall after the first date.
 */
export function cumulativeReturnPct(returns: readonly DailyReturn[], dates: readonly string[]): number[] {
  const base = dates[0] ?? '';
  let level = 1;
  let next = 0;
  return dates.map((date) => {
    while (next < returns.length && returns[next]!.date <= date) {
      const r = returns[next++]!;
      if (r.date > base) level *= 1 + r.r;
    }
    return ratioToPct(level - 1);
  });
}

/** Rebases a series to 0 % at its first value (percent change since then); gaps (null) stay null. */
export function rebasedReturnPct(values: readonly (number | null)[]): (number | null)[] {
  const base = values.find((v): v is number => v !== null);
  return values.map((v) => (v === null || !base ? null : ratioToPct(v / base - 1)));
}

/** Compounded return in percent per period (default month) from daily returns, in chronological order. */
export function periodReturnsPct(returns: readonly DailyReturn[], period: ReturnPeriod = 'month'): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const r of returns) {
    const key = periodKey(r.date, period);
    groups.set(key, [...(groups.get(key) ?? []), r.r]);
  }
  return new Map([...groups].map(([key, rs]) => [key, ratioToPct(chainReturns(rs))]));
}

/** Numbers behind "Your portfolio is ahead of / behind X by …"; null without a comparison. */
export function growthHeadline(symbol: string, comparison: BenchmarkComparison | null): GrowthHeadline | null {
  if (!comparison) return null;
  return {
    symbol,
    from: comparison.from,
    to: comparison.to,
    amount: roundTo(comparison.portfolioGain - comparison.benchmarkGain),
    differencePct: comparison.differencePct,
    portfolioReturnPct: comparison.portfolioReturnPct,
    benchmarkReturnPct: comparison.benchmarkReturnPct,
  };
}

/**
 * Selectable benchmarks: the candidates (tracked symbols) plus the suggestions that are not among them (without data).
 * Symbols with data come first, then alphabetical.
 */
export function buildBenchmarkOptions(
  candidates: readonly GrowthBenchmarkOption[],
  suggestions: readonly { symbol: string; name: string }[] = BENCHMARK_SUGGESTIONS,
): GrowthBenchmarkOption[] {
  const byName = new Map(suggestions.map((s) => [s.symbol, s.name]));
  const merged = new Map<string, GrowthBenchmarkOption>();
  for (const c of candidates) {
    const name = c.name ?? byName.get(c.symbol);
    merged.set(c.symbol, name === undefined ? { symbol: c.symbol, hasData: c.hasData } : { symbol: c.symbol, name, hasData: c.hasData });
  }
  for (const s of suggestions) if (!merged.has(s.symbol)) merged.set(s.symbol, { symbol: s.symbol, name: s.name, hasData: false });
  return [...merged.values()].sort((a, b) => Number(b.hasData) - Number(a.hasData) || a.symbol.localeCompare(b.symbol));
}

// --- Return of one holding -----------------------------------------------------------------------

export interface HoldingReturn {
  startValue: number;
  endValue: number;
  /** Purchases minus sales after the first day. */
  contributions: number;
  /** Net dividends received after the first day. */
  income: number;
  /** end − start − contributions + income. */
  gain: number;
  /** Time-weighted return (income included), percent. */
  returnPct: number;
}

/**
 * Return of a single holding over its daily value history (first point = start): TWR from the flow-adjusted daily returns
 * and the money made. Null without at least one day of return (history shorter than two points or nothing held at the start).
 */
export function holdingReturn(history: readonly ValuePoint[], flows: ReadonlyMap<string, DayFlows>): HoldingReturn | null {
  const first = history[0];
  const last = history.at(-1);
  if (!first || !last) return null;
  const returns = portfolioDailyReturns(history, flows);
  if (returns.length === 0) return null;
  let contributions = 0;
  let income = 0;
  for (const [date, f] of flows) {
    if (date <= first.date || date > last.date) continue;
    contributions += f.contributions;
    income += f.income;
  }
  return {
    startValue: first.value,
    endValue: last.value,
    contributions: roundTo(contributions),
    income: roundTo(income),
    gain: roundTo(last.value - first.value - contributions + income),
    returnPct: ratioToPct(chainReturns(returns.map((r) => r.r))),
  };
}

// --- Builders ------------------------------------------------------------------------------------

const noPoints = (n: number) => Array.from({ length: n }, () => ({ value: null, returnPct: null }));

function benchmarkSeries(ctx: Context, data: AnalyticsData, symbol: string, history: readonly ValuePoint[]): GrowthBenchmark {
  const from = history[0]!.date;
  const prices = benchmarkPrices(data.eod[symbol], ctx.timeline, from, data.today);
  if (prices.length === 0) return { symbol, available: false, message: noBenchmarkMessage(symbol), points: noPoints(history.length), comparison: null };
  const priceByDate = new Map(prices.map((p) => [p.date, p.price]));
  const replayed = replay(history, ctx.flows, priceByDate);
  const returns = rebasedReturnPct(replayed.map((p) => priceByDate.get(p.date) ?? null));
  return {
    symbol,
    available: true,
    points: replayed.map((p, i) => ({ value: p.benchmark, returnPct: returns[i]! })),
    comparison: compare(ctx, replayed, prices),
  };
}

function monthlyRows(ctx: Context, data: AnalyticsData, symbols: readonly string[]): GrowthMonthRow[] {
  const perSymbol = new Map(
    symbols.map((s) => {
      const prices = benchmarkPrices(data.eod[s], ctx.timeline, ctx.firstDate, data.today);
      return [s, prices.length > 0 ? periodReturnsPct(priceReturns(prices)) : null] as const;
    }),
  );
  return [...periodReturnsPct(ctx.returns)].map(([month, portfolioPct]) => ({
    month,
    portfolioPct,
    benchmarks: Object.fromEntries(symbols.map((s) => [s, perSymbol.get(s)?.get(month) ?? null])),
  }));
}

const emptyGrowth = (range: GrowthRange, baseCurrency: string, symbols: readonly string[], options: GrowthBenchmarkOption[]): AnalyticsGrowthResponse => ({
  range,
  baseCurrency,
  period: null,
  series: [],
  benchmarks: symbols.map((symbol) => ({ symbol, available: false, message: NO_TRANSACTIONS_MESSAGE, points: [], comparison: null })),
  headline: null,
  monthly: [],
  options,
});

/** Portfolio value/invested/return series plus one aligned series per requested benchmark. */
export function computeGrowth(data: AnalyticsData, range: GrowthRange, symbols: readonly string[], options: GrowthBenchmarkOption[]): AnalyticsGrowthResponse {
  const ctx = buildContext(data);
  if (!ctx) return emptyGrowth(range, data.fx.base, symbols, options);
  const history = ctx.history.filter((p) => p.date >= growthRangeStart(range, data.today, ctx.firstDate));
  const portfolio = replay(history, ctx.flows, null);
  const returnPct = cumulativeReturnPct(ctx.returns, portfolio.map((p) => p.date));
  const benchmarks = symbols.map((s) => benchmarkSeries(ctx, data, s, history));

  const keep = downsampleEvenly(
    portfolio.map((_, i) => i),
    MAX_ANALYTICS_POINTS,
  );
  const series: GrowthPoint[] = keep.map((i) => ({ date: portfolio[i]!.date, value: portfolio[i]!.portfolio, invested: portfolio[i]!.invested, returnPct: returnPct[i]! }));
  const first = portfolio[0]!;
  const last = portfolio.at(-1)!;
  const period: GrowthPeriod = {
    from: first.date,
    to: last.date,
    startValue: first.portfolio,
    endValue: last.portfolio,
    invested: last.invested,
    gain: roundTo(last.portfolio - last.invested),
    returnPct: returnPct.at(-1)!,
  };
  return {
    range,
    baseCurrency: data.fx.base,
    period,
    series,
    benchmarks: benchmarks.map((b) => ({ ...b, points: keep.map((i) => b.points[i]!) })),
    headline: benchmarks.map((b) => growthHeadline(b.symbol, b.comparison)).find((h) => h !== null) ?? null,
    monthly: monthlyRows(ctx, data, symbols),
    options,
  };
}

function holdingRow(
  ctx: Context,
  data: AnalyticsData,
  transactions: readonly Transaction[],
  holding: { symbol: string; name: string },
  start: string,
): HoldingPerformanceRow | null {
  const own = transactions.filter((t) => t.symbol === holding.symbol);
  const firstBuy = own.find((t) => t.type === 'BUY')?.date ?? start;
  const history = buildValueHistory(own, data.eod, data.fx, firstBuy > start ? firstBuy : start, data.today, data.fxHistory);
  const result = holdingReturn(history, dailyFlows(own, ctx.timeline));
  if (!result) return null;
  const from = history[0]!.date;
  return { symbol: holding.symbol, name: holding.name, returnPct: result.returnPct, gain: result.gain, from, sincePurchase: from > start };
}

/** Return of every open holding over the range; holdings bought inside the range are measured from their first purchase. */
export function computeHoldingsPerformance(data: AnalyticsData, range: GrowthRange): AnalyticsHoldingsPerformanceResponse {
  const base = { range, baseCurrency: data.fx.base, to: data.today };
  const ctx = buildContext(data);
  if (!ctx) return { ...base, from: null, holdings: [] };
  const start = growthRangeStart(range, data.today, ctx.firstDate);
  const transactions = sortTransactions(data.transactions.filter((t) => t.date <= data.today));
  const { holdings } = calculatePortfolio({
    transactions,
    quotes: data.quotes,
    profiles: data.profiles,
    fx: data.fx,
    fxHistory: data.fxHistory,
    now: data.now ?? new Date(`${data.today}T12:00:00Z`),
  });
  const rows = holdings.map((h) => holdingRow(ctx, data, transactions, h, start)).filter((r): r is HoldingPerformanceRow => r !== null);
  return { ...base, from: start, holdings: [...rows].sort((a, b) => b.returnPct - a.returnPct || a.symbol.localeCompare(b.symbol)) };
}
