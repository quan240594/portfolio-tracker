/** Dashboard window figures (GET /analytics/summary?period=): returns, dividends and realized P&L of the last year, year to date, 5 or 10 years. */
import {
  DAYS_PER_YEAR,
  addIsoDays,
  annualiseReturn,
  chainReturns,
  daysBetween,
  moneyWeightedReturn,
  ratioToPct,
  roundTo,
  type CashFlow,
} from './analytics.js';
import type { DashboardPeriod, PeriodPerformance } from './analytics-api.js';
import type { Context } from './analytics-compute.js';
import { buildPositions, type PortfolioResult, type Position } from './portfolio.js';
import type { Transaction } from './types.js';

const WINDOW_DAYS: Readonly<Record<'ttm' | '5y' | '10y', number>> = { ttm: DAYS_PER_YEAR, '5y': 5 * DAYS_PER_YEAR, '10y': 10 * DAYS_PER_YEAR };

/** The day before the window starts: the figures cover the days after it (like the per-year rows of GET /analytics/returns). */
export function periodBaseline(period: DashboardPeriod, today: string, firstDate: string): string {
  if (period === 'all') return addIsoDays(firstDate, -1);
  if (period === 'ytd') return `${Number(today.slice(0, 4)) - 1}-12-31`;
  return addIsoDays(today, -WINDOW_DAYS[period]);
}

interface Totals {
  realized: number;
  dividends: number;
  invested: number;
  cost: number;
}

const NO_POSITIONS: Totals = { realized: 0, dividends: 0, invested: 0, cost: 0 };

function totalsOf(positions: ReadonlyMap<string, Position>): Totals {
  const totals = { ...NO_POSITIONS };
  for (const p of positions.values()) {
    totals.realized += p.realizedPnlBase;
    totals.dividends += p.dividendsBase;
    totals.invested += p.investedBase;
    totals.cost += p.costBase;
  }
  return totals;
}

function valueOn(ctx: Context, date: string): number {
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    const point = ctx.history[i];
    if (point && point.date <= date) return point.value;
  }
  return 0;
}

export const emptyPeriodPerformance = (period: DashboardPeriod, today: string): PeriodPerformance => ({
  period,
  from: null,
  to: today,
  truncated: false,
  days: 0,
  irrPct: null,
  irrAnnualised: false,
  twrPct: null,
  twrAnnualisedPct: null,
  startValue: 0,
  endValue: 0,
  dividends: 0,
  realizedPnl: 0,
  totalReturn: 0,
  totalReturnPct: 0,
});

interface Inputs {
  ctx: Context | null;
  transactions: readonly Transaction[];
  portfolio: PortfolioResult;
  today: string;
}

/**
 * Figures of one window. They reuse the all-time rules (average cost, transaction-date FX, net dividends), so a window that
 * reaches back to the first transaction reproduces the all-time numbers; a longer window is cut at the history and flagged `truncated`.
 */
export function computePeriodPerformance(period: DashboardPeriod, { ctx, transactions, portfolio, today }: Readonly<Inputs>): PeriodPerformance {
  if (!ctx) return emptyPeriodPerformance(period, today);
  const requested = periodBaseline(period, today, ctx.firstDate);
  const covered = requested >= ctx.firstDate;
  const baseline = covered ? requested : addIsoDays(ctx.firstDate, -1);
  const start = covered ? totalsOf(buildPositions(transactions, baseline, ctx.timeline)) : NO_POSITIONS;
  const end = totalsOf(buildPositions(transactions, today, ctx.timeline));
  const startValue = covered ? valueOn(ctx, baseline) : 0;
  const endValue = portfolio.summary.totalValue;

  const realizedPnl = end.realized - start.realized;
  const dividends = end.dividends - start.dividends;
  const totalReturn = portfolio.summary.unrealizedPnl - (startValue - start.cost) + realizedPnl + dividends;
  const base = start.cost + end.invested - start.invested;

  const flows: CashFlow[] = [
    ...(startValue > 0 ? [{ date: baseline, amount: -startValue }] : []),
    ...ctx.cashFlows.filter((f) => f.date > baseline),
    { date: today, amount: endValue },
  ];
  const mwr = moneyWeightedReturn(flows);
  const returns = ctx.returns.filter((r) => r.date > baseline);
  const twr = returns.length > 0 ? chainReturns(returns.map((r) => r.r)) : null;
  const days = daysBetween(covered ? baseline : ctx.firstDate, today);
  const annualisedTwr = twr === null ? null : annualiseReturn(twr, days);

  return {
    period,
    from: addIsoDays(baseline, 1),
    to: today,
    truncated: requested < baseline,
    days,
    irrPct: mwr ? ratioToPct(mwr.rate) : null,
    irrAnnualised: mwr?.isAnnualised ?? false,
    twrPct: twr === null ? null : ratioToPct(twr),
    twrAnnualisedPct: annualisedTwr === null ? null : ratioToPct(annualisedTwr),
    startValue: roundTo(startValue),
    endValue: roundTo(endValue),
    dividends: roundTo(dividends),
    realizedPnl: roundTo(realizedPnl),
    totalReturn: roundTo(totalReturn),
    totalReturnPct: base > 0 ? ratioToPct(totalReturn / base) : 0,
  };
}
