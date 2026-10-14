/**
 * Pure analytics maths: money-weighted return (XIRR), time-weighted return, risk metrics, drawdown, beta,
 * movers and the income-goal projection. Everything here works on plain numbers/dates (ratios, not
 * percentages) and the base currency; the response builders live in `analytics-compute.ts`.
 *
 * Timing convention: a transaction on day D is part of the end-of-day value of D (that is how
 * `buildValueHistory` replays transactions), so the return of day D is
 * `(V_D − contributions_D + income_D) / V_(D−1) − 1`.
 */
import type { FxTimeline } from './fx.js';
import { txRate } from './portfolio.js';
import type { Holding, Transaction, ValuePoint } from './types.js';

export const DAYS_PER_YEAR = 365;
export const TRADING_DAYS_PER_YEAR = 252;
/** Annual risk-free rate used for Sharpe/Sortino unless the caller overrides it. */
export const DEFAULT_RISK_FREE_RATE = 0.025;
/** Below this many daily returns risk figures are not meaningful and are reported as null. */
export const MIN_RISK_OBSERVATIONS = 20;
/** Number of top gainers / losers listed. */
export const MOVERS_LIMIT = 5;

export const roundTo = (n: number, dp = 2): number => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;
/** Ratio (0.1) → percentage rounded to 2 decimals (10). */
export const ratioToPct = (ratio: number): number => roundTo(ratio * 100, 2);

const DAY_MS = 86_400_000;
const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

export function addIsoDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round(dayNumber(to) - dayNumber(from));

const isWeekend = (date: string): boolean => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

// --- Cash flows ------------------------------------------------------------------------------------

/** Signed from the investor's point of view: money paid in is negative, money received positive. */
export interface CashFlow {
  date: string;
  amount: number;
}

/** Net amount of a transaction in the base currency (buys incl. fee, sells/dividends net of fee/tax). */
export function transactionAmount(t: Transaction, timeline: FxTimeline): number {
  const gross = t.quantity * t.price;
  return (t.type === 'BUY' ? gross + t.fee : gross - t.fee) / txRate(t, timeline);
}

/**
 * Analytics measure the invested holdings, so only trades and dividends are flows. Cash movements (DEPOSIT,
 * WITHDRAWAL, FEE, INTEREST) and SPLIT carry no investment cash flow of their own: a split changes units, not value,
 * and cash balances are not part of the holdings value these returns are measured against.
 */
export const isInvestmentFlow = (t: Pick<Transaction, 'type'>): boolean => t.type === 'BUY' || t.type === 'SELL' || t.type === 'DIVIDEND';

export function transactionCashFlows(transactions: readonly Transaction[], timeline: FxTimeline): CashFlow[] {
  return transactions.filter(isInvestmentFlow).map((t) => {
    const amount = transactionAmount(t, timeline);
    return { date: t.date, amount: t.type === 'BUY' ? -amount : amount };
  });
}

export interface DayFlows {
  /** Buys minus sells: money moved into the portfolio (external flow for TWR). */
  contributions: number;
  /** Net dividends received: part of the return, not a flow. */
  income: number;
}

export function dailyFlows(transactions: readonly Transaction[], timeline: FxTimeline): Map<string, DayFlows> {
  const out = new Map<string, DayFlows>();
  for (const t of transactions.filter(isInvestmentFlow)) {
    const amount = transactionAmount(t, timeline);
    const day = out.get(t.date) ?? { contributions: 0, income: 0 };
    if (t.type === 'BUY') day.contributions += amount;
    else if (t.type === 'SELL') day.contributions -= amount;
    else day.income += amount;
    out.set(t.date, day);
  }
  return out;
}

// --- XIRR ------------------------------------------------------------------------------------------

const MIN_RATE = -0.999999;
/** Largest period return (1e6 = 100 000 000 %) the solver searches for. */
const MAX_RATE = 1e6;
const MAX_NEWTON_ITERATIONS = 60;
const MAX_BISECTION_ITERATIONS = 300;

interface TimedFlow {
  amount: number;
  /** Position within the whole span: 0 = first flow, 1 = last flow. */
  t: number;
}

const npv = (flows: readonly TimedFlow[], rate: number): number =>
  flows.reduce((sum, f) => sum + f.amount * (1 + rate) ** -f.t, 0);
const dnpv = (flows: readonly TimedFlow[], rate: number): number =>
  flows.reduce((sum, f) => sum - f.t * f.amount * (1 + rate) ** (-f.t - 1), 0);

function newton(flows: readonly TimedFlow[], guess: number): number | null {
  let rate = guess;
  for (let i = 0; i < MAX_NEWTON_ITERATIONS; i++) {
    const value = npv(flows, rate);
    const slope = dnpv(flows, rate);
    if (!Number.isFinite(value) || !Number.isFinite(slope) || slope === 0) return null;
    let next = rate - value / slope;
    // Never step to or below -100 %: halve the distance to it instead.
    if (next <= MIN_RATE) next = (rate + MIN_RATE) / 2;
    if (Math.abs(next - rate) < 1e-12) return next;
    rate = next;
  }
  return null;
}

function bisect(flows: readonly TimedFlow[]): number | null {
  let lo = MIN_RATE;
  let hi = 1;
  const signAtLo = Math.sign(npv(flows, lo));
  while (Math.sign(npv(flows, hi)) === signAtLo) {
    hi *= 2;
    if (hi > MAX_RATE) return null;
  }
  for (let i = 0; i < MAX_BISECTION_ITERATIONS && hi - lo > 1e-13; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sign(npv(flows, mid)) === signAtLo) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

interface IrrSolution {
  /** Total return over the span of the flows: the rate that discounts all flows to a zero NPV over that span. */
  periodReturn: number;
  /** Length of the span in years (actual/365). */
  years: number;
}

/**
 * Solves in "period" units (the whole span is one period) rather than per year: the root then equals the money-weighted
 * return over the span, which stays moderate even for spans of a day, so the numerics are well conditioned.
 */
function solveIrr(flows: readonly CashFlow[]): IrrSolution | null {
  const real = flows.filter((f) => f.amount !== 0 && Number.isFinite(f.amount));
  const days = flows.map((f) => dayNumber(f.date));
  const first = Math.min(...days);
  // The span includes zero-value flows: a terminal value of 0 still marks the end of the investment.
  const span = Math.max(...days) - first;
  if (span === 0 || !real.some((f) => f.amount < 0)) return null;
  if (!real.some((f) => f.amount > 0)) return { periodReturn: -1, years: span / DAYS_PER_YEAR };
  const timed = real.map((f) => ({ amount: f.amount, t: (dayNumber(f.date) - first) / span }));
  const root = newton(timed, 0.1);
  const scale = real.reduce((s, f) => s + Math.abs(f.amount), 0);
  const periodReturn = root !== null && root <= MAX_RATE && Math.abs(npv(timed, root)) < 1e-7 * scale ? root : bisect(timed);
  return periodReturn === null ? null : { periodReturn, years: span / DAYS_PER_YEAR };
}

const annualise = ({ periodReturn, years }: IrrSolution): number | null => {
  const annual = (1 + periodReturn) ** (1 / years) - 1;
  return Number.isFinite(annual) ? annual : null;
};

/**
 * Annualised internal rate of return of dated cash flows (actual/365), as a ratio (0.1 = 10 %).
 * Newton's method with a bisection fallback. Returns null when there is no meaningful rate: no outflow
 * (nothing was invested), all flows on one day, no root below a period return of 100 000 000 %, or an
 * annualised figure too large to represent. Money invested but never returned (only outflows, zero flows
 * ignored) is -1, i.e. a total loss.
 */
export function xirr(flows: readonly CashFlow[]): number | null {
  const solution = solveIrr(flows);
  return solution && annualise(solution);
}

export interface MoneyWeightedReturn {
  /** Annualised XIRR (ratio); null when it is too large to represent (very short spans). */
  annualised: number | null;
  /** Return over the whole span of the flows. */
  periodReturn: number;
  days: number;
  /** True when the span is at least a year, so `rate` is the annualised figure. */
  isAnnualised: boolean;
  /** `annualised` for spans of a year or more, otherwise `periodReturn` (short spans are not annualised). */
  rate: number;
}

export function moneyWeightedReturn(flows: readonly CashFlow[]): MoneyWeightedReturn | null {
  const solution = solveIrr(flows);
  if (!solution) return null;
  const days = Math.round(solution.years * DAYS_PER_YEAR);
  const annualised = annualise(solution);
  const isAnnualised = days >= DAYS_PER_YEAR && annualised !== null;
  return { annualised, periodReturn: solution.periodReturn, days, isAnnualised, rate: isAnnualised ? annualised : solution.periodReturn };
}

// --- Time-weighted return --------------------------------------------------------------------------

export interface DailyReturn {
  date: string;
  /** Flow-adjusted return of that day as a ratio. */
  r: number;
}

/**
 * Daily flow-adjusted portfolio returns. Days that follow a zero-value day (nothing held yet, or
 * everything sold) have no base to compare with and are skipped.
 */
export function portfolioDailyReturns(points: readonly ValuePoint[], flows: ReadonlyMap<string, DayFlows>): DailyReturn[] {
  const out: DailyReturn[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!.value;
    if (prev <= 0) continue;
    const cur = points[i]!;
    const f = flows.get(cur.date);
    out.push({ date: cur.date, r: (cur.value - (f?.contributions ?? 0) + (f?.income ?? 0)) / prev - 1 });
  }
  return out;
}

/** Geometric linking of sub-period returns: ∏(1 + r) − 1. */
export const chainReturns = (returns: readonly number[]): number => returns.reduce((acc, r) => acc * (1 + r), 1) - 1;

/** Annualises a cumulative return over `days`; null for spans shorter than a year (not annualised). */
export function annualiseReturn(cumulative: number, days: number): number | null {
  if (days < DAYS_PER_YEAR) return null;
  return (1 + cumulative) ** (DAYS_PER_YEAR / days) - 1;
}

export interface IndexPoint {
  date: string;
  /** Growth of 1 unit invested at `startDate`. */
  index: number;
}

export function wealthIndex(returns: readonly DailyReturn[], startDate: string): IndexPoint[] {
  let level = 1;
  const out: IndexPoint[] = [{ date: startDate, index: 1 }];
  for (const r of returns) {
    level *= 1 + r.r;
    out.push({ date: r.date, index: level });
  }
  return out;
}

/**
 * Collapses daily returns to weekday returns: weekend returns are compounded into the following weekday,
 * so annualising with 252 periods does not understate volatility with the zero-return weekend days.
 * A trailing weekend with no following weekday is dropped.
 */
export function toTradingDayReturns(returns: readonly DailyReturn[]): DailyReturn[] {
  const out: DailyReturn[] = [];
  let factor = 1;
  for (const { date, r } of returns) {
    factor *= 1 + r;
    if (isWeekend(date)) continue;
    out.push({ date, r: factor - 1 });
    factor = 1;
  }
  return out;
}

// --- Risk ------------------------------------------------------------------------------------------

export interface RiskStats {
  /** Annualised standard deviation of the returns (ratio). */
  volatility: number | null;
  sharpe: number | null;
  sortino: number | null;
}

/**
 * Annualised volatility, Sharpe and Sortino of periodic (trading-day) returns. Sharpe = mean excess
 * return / standard deviation × √252; Sortino divides by the downside deviation (below the daily
 * risk-free rate) instead. Null when there are fewer than two returns or the denominator is zero.
 */
export function riskStats(returns: readonly number[], riskFreeRate = DEFAULT_RISK_FREE_RATE): RiskStats {
  const n = returns.length;
  if (n < 2) return { volatility: null, sharpe: null, sortino: null };
  const rfDaily = (1 + riskFreeRate) ** (1 / TRADING_DAYS_PER_YEAR) - 1;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));
  const downside = Math.sqrt(returns.reduce((s, r) => s + Math.min(0, r - rfDaily) ** 2, 0) / n);
  const annual = Math.sqrt(TRADING_DAYS_PER_YEAR);
  return {
    volatility: std * annual,
    sharpe: std > 0 ? ((mean - rfDaily) / std) * annual : null,
    sortino: downside > 0 ? ((mean - rfDaily) / downside) * annual : null,
  };
}

export interface Drawdown {
  /** Peak-to-trough decline as a negative ratio (-0.2 = -20 %); 0 when the index never fell. */
  depth: number;
  peakDate: string | null;
  troughDate: string | null;
  /** First day after the trough on which the previous peak was regained, null while still under water. */
  recoveryDate: string | null;
}

export function maxDrawdown(levels: readonly IndexPoint[]): Drawdown | null {
  const first = levels[0];
  if (!first) return null;
  let peak = first;
  let worst = { depth: 0, peak: first, trough: first };
  for (const level of levels) {
    if (level.index > peak.index) peak = level;
    const depth = level.index / peak.index - 1;
    if (depth < worst.depth) worst = { depth, peak, trough: level };
  }
  if (worst.depth === 0) return { depth: 0, peakDate: null, troughDate: null, recoveryDate: null };
  const recovery = levels.find((l) => l.date > worst.trough.date && l.index >= worst.peak.index);
  return { depth: worst.depth, peakDate: worst.peak.date, troughDate: worst.trough.date, recoveryDate: recovery?.date ?? null };
}

export interface BetaResult {
  beta: number | null;
  correlation: number | null;
  observations: number;
}

/** Beta (cov / benchmark variance) and correlation over the dates both series share; null below two shared dates. */
export function betaVs(portfolio: readonly DailyReturn[], benchmark: readonly DailyReturn[]): BetaResult | null {
  const bench = new Map(benchmark.map((b) => [b.date, b.r]));
  const pairs = portfolio.filter((p) => bench.has(p.date)).map((p) => [p.r, bench.get(p.date)!] as const);
  const n = pairs.length;
  if (n < 2) return null;
  const mp = pairs.reduce((s, [p]) => s + p, 0) / n;
  const mb = pairs.reduce((s, [, b]) => s + b, 0) / n;
  let cov = 0;
  let varP = 0;
  let varB = 0;
  for (const [p, b] of pairs) {
    cov += (p - mp) * (b - mb);
    varP += (p - mp) ** 2;
    varB += (b - mb) ** 2;
  }
  return {
    beta: varB > 1e-18 ? cov / varB : null,
    correlation: varB > 1e-18 && varP > 1e-18 ? cov / Math.sqrt(varP * varB) : null,
    observations: n,
  };
}

// --- Periods ---------------------------------------------------------------------------------------

export const RETURN_PERIODS = ['year', 'quarter', 'month'] as const;
export type ReturnPeriod = (typeof RETURN_PERIODS)[number];

/** `2026`, `2026-Q3` or `2026-09` for a YYYY-MM-DD date. */
export function periodKey(date: string, period: ReturnPeriod): string {
  switch (period) {
    case 'year':
      return date.slice(0, 4);
    case 'quarter':
      return `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
    case 'month':
      return date.slice(0, 7);
  }
}

// --- Movers ----------------------------------------------------------------------------------------

export interface Mover {
  symbol: string;
  name: string;
  dayChangePct: number;
  dayChange: number;
}

const toMover = (h: Holding): Mover => ({ symbol: h.symbol, name: h.name, dayChangePct: h.dayChangePct, dayChange: h.dayChange });

/** Best and worst holdings by day change %, at most `limit` each; flat holdings are in neither list. */
export function topMovers(holdings: readonly Holding[], limit = MOVERS_LIMIT): { gainers: Mover[]; losers: Mover[] } {
  const bySymbol = (a: Mover, b: Mover) => a.symbol.localeCompare(b.symbol);
  const movers = holdings.map(toMover);
  return {
    gainers: movers
      .filter((m) => m.dayChangePct > 0)
      .sort((a, b) => b.dayChangePct - a.dayChangePct || bySymbol(a, b))
      .slice(0, limit),
    losers: movers
      .filter((m) => m.dayChangePct < 0)
      .sort((a, b) => a.dayChangePct - b.dayChangePct || bySymbol(a, b))
      .slice(0, limit),
  };
}

// --- Income goal -----------------------------------------------------------------------------------

export interface GoalInputs {
  /** Desired annual passive income (base currency). */
  targetIncome: number;
  /** Annual passive income today. */
  startIncome: number;
  /** Yearly growth of existing dividends, in percent. */
  dividendGrowthPct: number;
  /** Dividend yield on newly invested money, in percent. */
  yieldOnNewMoneyPct: number;
  monthlyContribution: number;
  /** Reinvest the dividends received at the yield on new money. */
  reinvestDividends: boolean;
  years: number;
}

export const GOAL_SCENARIOS = [
  { id: 'cautious', label: 'Cautious', growthDelta: -2, yieldDelta: -0.5 },
  { id: 'base', label: 'Base', growthDelta: 0, yieldDelta: 0 },
  { id: 'optimistic', label: 'Optimistic', growthDelta: 2, yieldDelta: 0.5 },
] as const;
export type GoalScenarioId = (typeof GOAL_SCENARIOS)[number]['id'];

export interface GoalPoint {
  /** Years from now (0 = today). */
  year: number;
  /** Annual passive income reached at that point. */
  income: number;
  /** Total contributed so far (excluding reinvested dividends). */
  contributed: number;
}

export interface GoalScenario {
  id: GoalScenarioId;
  label: string;
  dividendGrowthPct: number;
  yieldOnNewMoneyPct: number;
  /** Years until the income reaches the target (0 if already there), null if not within the horizon. */
  yearsToGoal: number | null;
  points: GoalPoint[];
}

/**
 * Monthly simulation of the annual income run-rate: existing income grows at the dividend growth rate,
 * every month the contribution (plus the reinvested dividends, if enabled) buys extra income at the
 * yield on new money. Points are the year-end values.
 */
function simulateGoal(inputs: GoalInputs, growthPct: number, yieldPct: number): { yearsToGoal: number | null; points: GoalPoint[] } {
  const monthlyGrowth = (1 + growthPct / 100) ** (1 / 12);
  let income = inputs.startIncome;
  let contributed = 0;
  let yearsToGoal: number | null = inputs.startIncome >= inputs.targetIncome ? 0 : null;
  const points: GoalPoint[] = [{ year: 0, income: roundTo(income), contributed: 0 }];
  for (let month = 1; month <= inputs.years * 12; month++) {
    income *= monthlyGrowth;
    income += (inputs.monthlyContribution + (inputs.reinvestDividends ? income / 12 : 0)) * (yieldPct / 100);
    contributed += inputs.monthlyContribution;
    if (yearsToGoal === null && income >= inputs.targetIncome) yearsToGoal = roundTo(month / 12, 2);
    if (month % 12 === 0) points.push({ year: month / 12, income: roundTo(income), contributed: roundTo(contributed) });
  }
  return { yearsToGoal, points };
}

/** Projected income for the cautious / base / optimistic scenarios (see GOAL_SCENARIOS). */
export function projectIncomeGoal(inputs: GoalInputs): GoalScenario[] {
  return GOAL_SCENARIOS.map((s) => {
    const dividendGrowthPct = Math.max(0, inputs.dividendGrowthPct + s.growthDelta);
    const yieldOnNewMoneyPct = Math.max(0, inputs.yieldOnNewMoneyPct + s.yieldDelta);
    return { id: s.id, label: s.label, dividendGrowthPct, yieldOnNewMoneyPct, ...simulateGoal(inputs, dividendGrowthPct, yieldOnNewMoneyPct) };
  });
}

/** Evenly samples down to at most `max` entries, always keeping the first and last. */
export function downsampleEvenly<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]!);
}
