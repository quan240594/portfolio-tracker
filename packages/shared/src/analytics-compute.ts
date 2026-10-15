/**
 * Response builders for the analytics endpoints. They take the raw stored data (transactions, quotes, FX, end-of-day
 * prices, dividend events) and return exactly what the API sends, so the Lambda and the web demo's mock backend
 * share one implementation.
 */
import { FxTimeline } from './fx.js';
import {
  DEFAULT_RISK_FREE_RATE,
  MIN_RISK_OBSERVATIONS,
  addIsoDays,
  betaVs,
  chainReturns,
  annualiseReturn,
  dailyFlows,
  isInvestmentFlow,
  daysBetween,
  downsampleEvenly,
  maxDrawdown,
  moneyWeightedReturn,
  periodKey,
  portfolioDailyReturns,
  projectIncomeGoal,
  ratioToPct,
  riskStats,
  roundTo,
  toTradingDayReturns,
  topMovers,
  transactionCashFlows,
  wealthIndex,
  type CashFlow,
  type DailyReturn,
  type DayFlows,
  type ReturnPeriod,
} from './analytics.js';
import {
  DEFAULT_BENCHMARK,
  type AnalyticsBenchmarkResponse,
  type AnalyticsGoalQuery,
  type AnalyticsGoalResponse,
  type AnalyticsReturnsResponse,
  type AnalyticsRiskResponse,
  type AnalyticsSummaryResponse,
  type BenchmarkComparison,
  type BenchmarkInfo,
  type BenchmarkPoint,
  type PerformanceSummary,
  type ReturnPeriodRow,
} from './analytics-api.js';
import { calculateDividendGrowth, calculatePassiveIncome, type DividendGrowth, type PassiveIncome } from './analytics-income.js';
import { generateInsights } from './analytics-insights.js';
import { buildValueHistory, calculatePortfolio, historyRangeStart, sortTransactions, type PortfolioResult } from './portfolio.js';
import type { HistoryRange } from './schemas.js';
import type { DividendEvent, EodPrice, FxDay, FxRates, InstrumentProfile, Quote, Transaction, ValuePoint } from './types.js';

/** Upper bound of points in chart series (same cap as GET /history). */
export const MAX_ANALYTICS_POINTS = 400;

export interface AnalyticsData {
  transactions: readonly Transaction[];
  quotes: Readonly<Record<string, Quote>>;
  profiles: Readonly<Record<string, InstrumentProfile>>;
  fx: FxRates;
  fxHistory?: readonly FxDay[];
  /** End-of-day prices per symbol: every symbol ever traded, plus the benchmark when one is compared against. */
  eod: Readonly<Record<string, readonly EodPrice[]>>;
  dividendEvents: readonly DividendEvent[];
  /** YYYY-MM-DD; the "current" day of all calculations. */
  today: string;
  now?: Date;
}

export interface Context {
  timeline: FxTimeline;
  firstDate: string;
  history: ValuePoint[];
  flows: Map<string, DayFlows>;
  cashFlows: CashFlow[];
  returns: DailyReturn[];
}

/** Daily value history, flows and flow-adjusted returns from the first transaction to today; null without transactions. */
export function buildContext(data: AnalyticsData): Context | null {
  const transactions = sortTransactions(data.transactions).filter((t) => t.date <= data.today);
  // "Since" is the first investment transaction, not e.g. an earlier cash deposit.
  const first = transactions.find(isInvestmentFlow);
  if (!first) return null;
  const timeline = new FxTimeline(data.fx, data.fxHistory);
  const history = buildValueHistory(transactions, data.eod, data.fx, first.date, data.today, data.fxHistory);
  const flows = dailyFlows(transactions, timeline);
  return {
    timeline,
    firstDate: first.date,
    history,
    flows,
    cashFlows: transactionCashFlows(transactions, timeline),
    returns: portfolioDailyReturns(history, flows),
  };
}

const scopedTransactions = (data: AnalyticsData): Transaction[] => data.transactions.filter((t) => t.date <= data.today);

function currentPortfolio(data: AnalyticsData): PortfolioResult {
  return calculatePortfolio({
    transactions: scopedTransactions(data),
    quotes: data.quotes,
    profiles: data.profiles,
    fx: data.fx,
    fxHistory: data.fxHistory,
    now: data.now ?? new Date(`${data.today}T12:00:00Z`),
  });
}

function passiveIncomeOf(data: AnalyticsData, portfolio: PortfolioResult): PassiveIncome {
  return calculatePassiveIncome(portfolio.holdings, scopedTransactions(data), data.dividendEvents, new FxTimeline(data.fx, data.fxHistory), data.today);
}

// --- Summary ---------------------------------------------------------------------------------------

const EMPTY_PERFORMANCE: PerformanceSummary = { since: null, days: 0, irrPct: null, irrAnnualised: false, twrPct: null, twrAnnualisedPct: null };

function performanceOf(ctx: Context, terminalValue: number, today: string): PerformanceSummary {
  const days = daysBetween(ctx.firstDate, today);
  const mwr = moneyWeightedReturn([...ctx.cashFlows, { date: today, amount: terminalValue }]);
  const twr = ctx.returns.length > 0 ? chainReturns(ctx.returns.map((r) => r.r)) : null;
  const annualisedTwr = twr === null ? null : annualiseReturn(twr, days);
  return {
    since: ctx.firstDate,
    days,
    irrPct: mwr ? ratioToPct(mwr.rate) : null,
    irrAnnualised: mwr?.isAnnualised ?? false,
    twrPct: twr === null ? null : ratioToPct(twr),
    twrAnnualisedPct: annualisedTwr === null ? null : ratioToPct(annualisedTwr),
  };
}

export function computeAnalyticsSummary(data: AnalyticsData): AnalyticsSummaryResponse {
  const ctx = buildContext(data);
  const portfolio = currentPortfolio(data);
  const passiveIncome = passiveIncomeOf(data, portfolio);
  return {
    baseCurrency: data.fx.base,
    asOf: portfolio.summary.asOf,
    performance: ctx ? performanceOf(ctx, portfolio.summary.totalValue, data.today) : EMPTY_PERFORMANCE,
    passiveIncome,
    ...topMovers(portfolio.holdings),
    insights: generateInsights(portfolio.holdings, passiveIncome),
  };
}

// --- Returns by period -----------------------------------------------------------------------------

function groupByPeriod(returns: readonly DailyReturn[], period: ReturnPeriod): DailyReturn[][] {
  const groups = new Map<string, DailyReturn[]>();
  for (const r of returns) {
    const key = periodKey(r.date, period);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()];
}

function periodRow(ctx: Context, group: readonly DailyReturn[], period: ReturnPeriod): ReturnPeriodRow {
  const first = group[0]!;
  const end = group.at(-1)!.date;
  const start = addIsoDays(first.date, -1);
  const valueOn = (date: string) => ctx.history.find((p) => p.date === date)?.value ?? 0;
  const startValue = valueOn(start);
  const endValue = valueOn(end);
  let contributions = 0;
  let income = 0;
  for (const [date, f] of ctx.flows) {
    if (date <= start || date > end) continue;
    contributions += f.contributions;
    income += f.income;
  }
  let irrPct: number | null = null;
  if (period === 'year') {
    const flows: CashFlow[] = [
      { date: start, amount: -startValue },
      ...ctx.cashFlows.filter((f) => f.date > start && f.date <= end),
      { date: end, amount: endValue },
    ];
    const mwr = moneyWeightedReturn(flows);
    irrPct = mwr ? ratioToPct(mwr.rate) : null;
  }
  return {
    period: periodKey(first.date, period),
    start,
    end,
    twrPct: ratioToPct(chainReturns(group.map((r) => r.r))),
    irrPct,
    startValue: roundTo(startValue),
    endValue: roundTo(endValue),
    contributions: roundTo(contributions),
    income: roundTo(income),
    gain: roundTo(endValue - startValue - contributions + income),
  };
}

export function computeReturns(data: AnalyticsData, period: ReturnPeriod): AnalyticsReturnsResponse {
  const ctx = buildContext(data);
  const rows = ctx ? groupByPeriod(ctx.returns, period).map((g) => periodRow(ctx, g, period)) : [];
  return { period, baseCurrency: data.fx.base, rows };
}

// --- Benchmark helpers -----------------------------------------------------------------------------

export interface PricePoint {
  date: string;
  /** Price per unit in the base currency. */
  price: number;
}

/** Daily benchmark prices in the base currency from `from` (or the first close) to `to`, carrying closes over gaps. */
export function benchmarkPrices(eod: readonly EodPrice[] | undefined, timeline: FxTimeline, from: string, to: string): PricePoint[] {
  const closes = [...(eod ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const firstClose = closes[0];
  if (!firstClose) return [];
  const out: PricePoint[] = [];
  let next = 0;
  let last = firstClose;
  for (let date = from > firstClose.date ? from : firstClose.date; date <= to; date = addIsoDays(date, 1)) {
    while (next < closes.length && closes[next]!.date <= date) last = closes[next++]!;
    out.push({ date, price: timeline.toBase(last.close, last.currency, date) });
  }
  return out;
}

export const priceReturns = (prices: readonly PricePoint[]): DailyReturn[] =>
  prices.slice(1).map((p, i) => ({ date: p.date, r: p.price / prices[i]!.price - 1 }));

export const noBenchmarkMessage = (symbol: string): string =>
  `No end-of-day prices are tracked for ${symbol} in this period, so it cannot be used as a benchmark. Pick another benchmark or add it to a portfolio to start tracking it.`;

export const NO_TRANSACTIONS_MESSAGE = 'Add transactions to compare your portfolio with a benchmark.';

// --- Risk ------------------------------------------------------------------------------------------

function riskBenchmark(ctx: Context, symbol: string, data: AnalyticsData, trading: readonly DailyReturn[]): AnalyticsRiskResponse['benchmark'] {
  const from = ctx.returns[0] ? addIsoDays(ctx.returns[0].date, -1) : ctx.firstDate;
  const prices = benchmarkPrices(data.eod[symbol], ctx.timeline, from, data.today);
  if (prices.length < 2) return { symbol, available: false, message: noBenchmarkMessage(symbol), beta: null, correlation: null };
  const result = betaVs(trading, toTradingDayReturns(priceReturns(prices)));
  if (!result || result.observations < MIN_RISK_OBSERVATIONS) {
    return { symbol, available: true, message: 'Not enough overlapping history to estimate beta.', beta: null, correlation: null };
  }
  return {
    symbol,
    available: true,
    beta: result.beta === null ? null : roundTo(result.beta),
    correlation: result.correlation === null ? null : roundTo(result.correlation),
  };
}

const EMPTY_RISK = { from: null, to: null, observations: 0, volatilityPct: null, sharpe: null, sortino: null, maxDrawdown: null } as const;

export function computeRisk(data: AnalyticsData, benchmark: string = DEFAULT_BENCHMARK, riskFreeRate: number = DEFAULT_RISK_FREE_RATE): AnalyticsRiskResponse {
  const base = { baseCurrency: data.fx.base, riskFreeRatePct: ratioToPct(riskFreeRate) };
  const ctx = buildContext(data);
  const first = ctx?.returns[0];
  if (!ctx || !first) {
    return { ...base, ...EMPTY_RISK, benchmark: { symbol: benchmark, available: false, message: NO_TRANSACTIONS_MESSAGE, beta: null, correlation: null } };
  }
  const trading = toTradingDayReturns(ctx.returns);
  const enough = trading.length >= MIN_RISK_OBSERVATIONS;
  const stats = riskStats(enough ? trading.map((r) => r.r) : [], riskFreeRate);
  const drawdown = maxDrawdown(wealthIndex(ctx.returns, addIsoDays(first.date, -1)));
  return {
    ...base,
    observations: trading.length,
    from: first.date,
    to: ctx.returns.at(-1)!.date,
    volatilityPct: stats.volatility === null ? null : ratioToPct(stats.volatility),
    sharpe: stats.sharpe === null ? null : roundTo(stats.sharpe),
    sortino: stats.sortino === null ? null : roundTo(stats.sortino),
    maxDrawdown: drawdown && {
      depthPct: ratioToPct(drawdown.depth),
      peakDate: drawdown.peakDate,
      troughDate: drawdown.troughDate,
      recoveryDate: drawdown.recoveryDate,
    },
    benchmark: riskBenchmark(ctx, benchmark, data, trading),
  };
}

// --- Benchmark comparison --------------------------------------------------------------------------

/**
 * Portfolio value (+ dividends received since the start) next to the benchmark replayed with the same net
 * buys and sells: the starting value is put into the benchmark on day one, later flows buy/sell it at that day's price.
 */
export function replay(history: readonly ValuePoint[], flows: ReadonlyMap<string, DayFlows>, prices: ReadonlyMap<string, number> | null): BenchmarkPoint[] {
  let units = 0;
  let invested = 0;
  let income = 0;
  return history.map((p, i) => {
    const price = prices?.get(p.date);
    const f = flows.get(p.date);
    if (i === 0) {
      invested = p.value;
      units = price ? p.value / price : 0;
    } else {
      invested += f?.contributions ?? 0;
      income += f?.income ?? 0;
      if (price && f) units = Math.max(0, units + f.contributions / price);
    }
    return {
      date: p.date,
      portfolio: roundTo(p.value + income),
      benchmark: price === undefined ? null : roundTo(units * price),
      invested: roundTo(invested),
    };
  });
}

export function compare(ctx: Context, points: readonly BenchmarkPoint[], prices: readonly PricePoint[]): BenchmarkComparison | null {
  const first = points[0];
  const last = points.at(-1);
  const lastPrice = prices.at(-1);
  if (!first || !last || !lastPrice || points.length < 2 || last.benchmark === null) return null;
  const portfolioReturn = chainReturns(ctx.returns.filter((r) => r.date > first.date).map((r) => r.r));
  const benchmarkReturn = lastPrice.price / prices[0]!.price - 1;
  return {
    from: first.date,
    to: last.date,
    portfolioReturnPct: ratioToPct(portfolioReturn),
    benchmarkReturnPct: ratioToPct(benchmarkReturn),
    differencePct: roundTo(ratioToPct(portfolioReturn) - ratioToPct(benchmarkReturn)),
    portfolioGain: roundTo(last.portfolio - last.invested),
    benchmarkGain: roundTo(last.benchmark - last.invested),
  };
}

export function computeBenchmark(data: AnalyticsData, benchmark: string = DEFAULT_BENCHMARK, range: HistoryRange = '1Y'): AnalyticsBenchmarkResponse {
  const base = { range, baseCurrency: data.fx.base };
  const ctx = buildContext(data);
  if (!ctx) {
    return { ...base, benchmark: { symbol: benchmark, available: false, message: NO_TRANSACTIONS_MESSAGE }, points: [], comparison: null };
  }
  const rangeStart = historyRangeStart(range, data.today, ctx.firstDate);
  const prices = benchmarkPrices(data.eod[benchmark], ctx.timeline, rangeStart > ctx.firstDate ? rangeStart : ctx.firstDate, data.today);
  const available = prices.length > 0;
  // The comparison starts once both the portfolio and the benchmark have data.
  const start = prices[0]?.date ?? (rangeStart > ctx.firstDate ? rangeStart : ctx.firstDate);
  const points = replay(
    ctx.history.filter((p) => p.date >= start),
    ctx.flows,
    available ? new Map(prices.map((p) => [p.date, p.price])) : null,
  );
  const info: BenchmarkInfo = available ? { symbol: benchmark, available } : { symbol: benchmark, available, message: noBenchmarkMessage(benchmark) };
  return {
    ...base,
    benchmark: info,
    points: downsampleEvenly(points, MAX_ANALYTICS_POINTS),
    comparison: available ? compare(ctx, points, prices) : null,
  };
}

// --- Dividend growth and goal ----------------------------------------------------------------------

export function computeDividendGrowth(data: AnalyticsData): DividendGrowth {
  return calculateDividendGrowth(scopedTransactions(data), new FxTimeline(data.fx, data.fxHistory), data.today);
}

export function computeGoal(data: AnalyticsData, query: Omit<AnalyticsGoalQuery, 'portfolioId'>): AnalyticsGoalResponse {
  const portfolio = currentPortfolio(data);
  const income = passiveIncomeOf(data, portfolio);
  const currentValue = portfolio.summary.totalValue;
  const override = query.currentYieldPct;
  const currentIncome = override === undefined ? income.forward12m : roundTo((currentValue * override) / 100);
  return {
    baseCurrency: data.fx.base,
    inputs: {
      targetIncome: query.targetIncome,
      currentValue,
      currentIncome,
      currentYieldPct: override ?? income.yieldOnValuePct,
      dividendGrowthPct: query.dividendGrowthPct,
      yieldOnNewMoneyPct: query.yieldOnNewMoneyPct,
      monthlyContribution: query.monthlyContribution,
      reinvestDividends: query.reinvestDividends,
      years: query.years,
    },
    scenarios: projectIncomeGoal({
      targetIncome: query.targetIncome,
      startIncome: currentIncome,
      dividendGrowthPct: query.dividendGrowthPct,
      yieldOnNewMoneyPct: query.yieldOnNewMoneyPct,
      monthlyContribution: query.monthlyContribution,
      reinvestDividends: query.reinvestDividends,
      years: query.years,
    }),
  };
}
