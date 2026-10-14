import { FxTimeline } from './fx.js';
import type {
  AllocationDimension,
  AllocationSlice,
  DividendEvent,
  DividendOverview,
  DividendPayment,
  EodPrice,
  FxDay,
  FxRates,
  Holding,
  InstrumentProfile,
  PortfolioSummary,
  Quote,
  Transaction,
  ValuePoint,
} from './types.js';

export class PortfolioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortfolioError';
  }
}

const EPSILON = 1e-9;
const round = (n: number, dp = 2) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;
const pct = (num: number, den: number) => (Math.abs(den) < EPSILON ? 0 : round((num / den) * 100, 2));

export function sortTransactions(txns: readonly Transaction[]): Transaction[] {
  return [...txns].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}

/**
 * Per-symbol position state (average-cost method), tracked both in the instrument's local currency
 * and in the portfolio base currency at the FX rate of each transaction.
 */
export interface Position {
  symbol: string;
  currency: string;
  quantity: number;
  costLocal: number;
  costBase: number;
  realizedPnlLocal: number;
  realizedPnlBase: number;
  dividendsLocal: number;
  dividendsBase: number;
  /** Total ever paid for buys (incl. fees) in base currency; denominator for total return %. */
  investedBase: number;
}

/**
 * FX rate for a transaction: the broker-reported `fxRate` wins, then the ECB fixing for the trade
 * date, then the latest rate. Without a timeline (e.g. pure oversell validation) base == local.
 */
function txRate(t: Transaction, fx?: FxTimeline): number {
  if (!fx || t.currency === fx.base) return 1;
  return t.fxRate && t.fxRate > 0 ? t.fxRate : fx.rate(t.currency, t.date);
}

/** Replays transactions up to and including `asOfDate`, throws on overselling. */
export function buildPositions(txns: readonly Transaction[], asOfDate?: string, fx?: FxTimeline): Map<string, Position> {
  const positions = new Map<string, Position>();
  for (const t of sortTransactions(txns)) {
    if (asOfDate && t.date > asOfDate) break;
    applyTransaction(positions, t, fx);
  }
  return positions;
}

/** Mutates `positions` by applying a single transaction (caller guarantees chronological order). */
export function applyTransaction(positions: Map<string, Position>, t: Transaction, fx?: FxTimeline): void {
  let p = positions.get(t.symbol);
  if (!p) {
    p = {
      symbol: t.symbol,
      currency: t.currency,
      quantity: 0,
      costLocal: 0,
      costBase: 0,
      realizedPnlLocal: 0,
      realizedPnlBase: 0,
      dividendsLocal: 0,
      dividendsBase: 0,
      investedBase: 0,
    };
    positions.set(t.symbol, p);
  }
  if (t.currency !== p.currency) {
    throw new PortfolioError(`Mixed currencies for ${t.symbol}: ${p.currency} and ${t.currency}`);
  }
  const rate = txRate(t, fx);
  switch (t.type) {
    case 'BUY': {
      const cost = t.quantity * t.price + t.fee;
      p.quantity += t.quantity;
      p.costLocal += cost;
      p.costBase += cost / rate;
      p.investedBase += cost / rate;
      break;
    }
    case 'SELL': {
      if (t.quantity > p.quantity + EPSILON) {
        throw new PortfolioError(`Cannot sell ${t.quantity} ${t.symbol} on ${t.date}: only ${p.quantity} held`);
      }
      const share = p.quantity > 0 ? t.quantity / p.quantity : 0;
      const removedLocal = p.costLocal * share;
      const removedBase = p.costBase * share;
      const proceeds = t.quantity * t.price - t.fee;
      p.realizedPnlLocal += proceeds - removedLocal;
      p.realizedPnlBase += proceeds / rate - removedBase;
      p.costLocal -= removedLocal;
      p.costBase -= removedBase;
      p.quantity -= t.quantity;
      if (p.quantity < EPSILON) {
        p.quantity = 0;
        p.costLocal = 0;
        p.costBase = 0;
      }
      break;
    }
    case 'DIVIDEND': {
      const net = t.quantity * t.price - t.fee;
      p.dividendsLocal += net;
      p.dividendsBase += net / rate;
      break;
    }
  }
}

export interface PortfolioInput {
  transactions: readonly Transaction[];
  quotes: Readonly<Record<string, Quote>>;
  profiles: Readonly<Record<string, InstrumentProfile>>;
  /** Latest FX rates (market values are always converted at these). */
  fx: FxRates;
  /** Daily ECB fixings used to convert each transaction at its own date. */
  fxHistory?: readonly FxDay[];
  now?: Date;
}

export interface PortfolioResult {
  summary: PortfolioSummary;
  holdings: Holding[];
}

/**
 * Computes current holdings and summary in the base currency. Costs, realized P&L and dividends use
 * the FX rate of each transaction (broker rate > ECB fixing > latest); market values use the latest
 * rate, so unrealized P&L includes the currency effect, reported separately as `currencyEffect`.
 * Fully sold holdings are excluded from `holdings` but still count in realized P&L and dividends.
 */
export function calculatePortfolio({ transactions, quotes, profiles, fx, fxHistory, now = new Date() }: PortfolioInput): PortfolioResult {
  const timeline = new FxTimeline(fx, fxHistory);
  const positions = buildPositions(transactions, undefined, timeline);
  const holdings: Holding[] = [];
  let realizedPnl = 0;
  let dividendsReceived = 0;
  let invested = 0;

  for (const p of positions.values()) {
    realizedPnl += p.realizedPnlBase;
    dividendsReceived += p.dividendsBase;
    invested += p.investedBase;
    if (p.quantity <= 0) continue;

    const quote = quotes[p.symbol];
    const profile = profiles[p.symbol];
    const avgLocal = p.costLocal / p.quantity;
    const priceLocal = quote?.price ?? avgLocal;
    const prevLocal = quote?.previousClose ?? priceLocal;
    const priceCurrency = quote?.currency ?? p.currency;

    const marketValue = timeline.toBase(p.quantity * priceLocal, priceCurrency);
    const dayChange = timeline.toBase(p.quantity * (priceLocal - prevLocal), priceCurrency);
    const prevValue = marketValue - dayChange;
    // Value had FX stayed at the (cost-weighted) purchase rates; the difference is the FX effect.
    const valueAtCostFx = priceCurrency === p.currency && p.costLocal > 0 ? (p.quantity * priceLocal * p.costBase) / p.costLocal : marketValue;

    holdings.push({
      symbol: p.symbol,
      name: profile?.name ?? p.symbol,
      assetClass: profile?.assetClass ?? 'OTHER',
      sector: profile?.sector ?? 'Unknown',
      country: profile?.country ?? 'Unknown',
      currency: p.currency,
      quantity: p.quantity,
      averageCostLocal: round(avgLocal, 4),
      priceLocal,
      averageCostBase: round(p.costBase / p.quantity, 4),
      priceBase: round(marketValue / p.quantity, 4),
      priceStale: !quote,
      costBasis: round(p.costBase),
      marketValue: round(marketValue),
      unrealizedPnl: round(marketValue - p.costBase),
      unrealizedPnlPct: pct(marketValue - p.costBase, p.costBase),
      currencyEffect: round(marketValue - valueAtCostFx),
      dayChange: round(dayChange),
      dayChangePct: pct(dayChange, prevValue),
      realizedPnl: round(p.realizedPnlBase),
      dividendsReceived: round(p.dividendsBase),
      weight: 0,
    });
  }

  const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const totalCost = holdings.reduce((s, h) => s + h.costBasis, 0);
  const dayChange = holdings.reduce((s, h) => s + h.dayChange, 0);
  const currencyEffect = holdings.reduce((s, h) => s + h.currencyEffect, 0);
  for (const h of holdings) h.weight = totalValue > 0 ? round(h.marketValue / totalValue, 4) : 0;
  holdings.sort((a, b) => b.marketValue - a.marketValue);

  const unrealizedPnl = totalValue - totalCost;
  const totalReturn = unrealizedPnl + realizedPnl + dividendsReceived;

  return {
    holdings,
    summary: {
      baseCurrency: fx.base,
      totalValue: round(totalValue),
      totalCost: round(totalCost),
      unrealizedPnl: round(unrealizedPnl),
      unrealizedPnlPct: pct(unrealizedPnl, totalCost),
      currencyEffect: round(currencyEffect),
      realizedPnl: round(realizedPnl),
      dividendsReceived: round(dividendsReceived),
      totalReturn: round(totalReturn),
      totalReturnPct: pct(totalReturn, invested),
      dayChange: round(dayChange),
      dayChangePct: pct(dayChange, totalValue - dayChange),
      holdingsCount: holdings.length,
      asOf: now.toISOString(),
    },
  };
}

export function calculateAllocation(holdings: readonly Holding[], by: AllocationDimension): AllocationSlice[] {
  const total = holdings.reduce((s, h) => s + h.marketValue, 0);
  const groups = new Map<string, { label: string; value: number }>();
  for (const h of holdings) {
    const key = String(h[by]);
    const label = by === 'symbol' ? `${h.symbol} · ${h.name}` : key;
    const g = groups.get(key) ?? { label, value: 0 };
    g.value += h.marketValue;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label, value: round(g.value), weight: total > 0 ? round(g.value / total, 4) : 0 }))
    .sort((a, b) => b.value - a.value);
}

const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Closes before `start`: the latest one per symbol seeds the carry-forward. */
function seedLastClose(eod: Readonly<Record<string, readonly EodPrice[]>>, start: string): Map<string, number> {
  const lastClose = new Map<string, number>();
  for (const [symbol, prices] of Object.entries(eod)) {
    const prior = prices.filter((p) => p.date < start).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    if (prior) lastClose.set(symbol, prior.close);
  }
  return lastClose;
}

/** Market value and cost basis (base currency) of the open positions on `date`; updates `lastClose`. */
function valuePositionsOn(
  positions: ReadonlyMap<string, Position>,
  closeIndex: ReadonlyMap<string, ReadonlyMap<string, number>>,
  lastClose: Map<string, number>,
  timeline: FxTimeline,
  date: string,
): { value: number; invested: number } {
  let value = 0;
  let invested = 0;
  for (const p of positions.values()) {
    const close = closeIndex.get(p.symbol)?.get(date);
    if (close !== undefined) lastClose.set(p.symbol, close);
    if (p.quantity <= 0) continue;
    const price = lastClose.get(p.symbol) ?? p.costLocal / p.quantity;
    value += timeline.toBase(p.quantity * price, p.currency, date);
    invested += p.costBase;
  }
  return { value, invested };
}

/**
 * Daily portfolio value series between `from` and `to` (inclusive) in the base currency.
 * Each day's value uses that day's ECB fixing (carried over weekends/holidays) when `fxHistory` is
 * given, else the latest rate; `invested` is the cost basis at the purchase-date rates.
 * Missing closes carry forward the last known close, falling back to the position's average cost.
 */
export function buildValueHistory(
  transactions: readonly Transaction[],
  eod: Readonly<Record<string, readonly EodPrice[]>>,
  fx: FxRates,
  from: string,
  to: string,
  fxHistory?: readonly FxDay[],
): ValuePoint[] {
  const sorted = sortTransactions(transactions);
  if (sorted.length === 0 || from > to) return [];
  const timeline = new FxTimeline(fx, fxHistory);
  const start = from < sorted[0]!.date ? sorted[0]!.date : from;

  const closeIndex = new Map<string, Map<string, number>>();
  for (const [symbol, prices] of Object.entries(eod)) {
    closeIndex.set(symbol, new Map(prices.map((p) => [p.date, p.close])));
  }

  const lastClose = seedLastClose(eod, start);
  const points: ValuePoint[] = [];
  const positions = new Map<string, Position>();
  let next = 0;
  for (let date = start; date <= to; date = addDays(date, 1)) {
    while (next < sorted.length && sorted[next]!.date <= date) applyTransaction(positions, sorted[next++]!, timeline);
    const { value, invested } = valuePositionsOn(positions, closeIndex, lastClose, timeline, date);
    points.push({ date, value: round(value), invested: round(invested) });
  }
  return points;
}

/**
 * Received = DIVIDEND transactions, converted at their own date's rate (broker rate > ECB fixing).
 * Upcoming = announced DividendEvents with exDate > today × current quantity (gross, latest FX).
 * Projection for the next 12 months = max(trailing-12-month received, upcoming).
 */
export function calculateDividends(
  transactions: readonly Transaction[],
  events: readonly DividendEvent[],
  fx: FxRates,
  today: string = new Date().toISOString().slice(0, 10),
  fxHistory?: readonly FxDay[],
): DividendOverview {
  const timeline = new FxTimeline(fx, fxHistory);
  const received: DividendPayment[] = sortTransactions(transactions)
    .filter((t) => t.type === 'DIVIDEND')
    .map((t) => ({
      symbol: t.symbol,
      date: t.date,
      perShareLocal: t.price,
      currency: t.currency,
      amount: (t.quantity * t.price - t.fee) / txRate(t, timeline),
      status: 'RECEIVED' as const,
    }));

  const positions = buildPositions(transactions);
  const upcoming: DividendPayment[] = events
    .filter((e) => e.exDate > today && (positions.get(e.symbol)?.quantity ?? 0) > 0)
    .map((e) => ({
      symbol: e.symbol,
      date: e.payDate ?? e.exDate,
      perShareLocal: e.amount,
      currency: e.currency,
      amount: timeline.toBase(positions.get(e.symbol)!.quantity * e.amount, e.currency),
      status: 'UPCOMING' as const,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const yearAgo = addDays(today, -365);
  const last12Months = received.filter((d) => d.date > yearAgo && d.date <= today).reduce((s, d) => s + d.amount, 0);
  const upcomingTotal = upcoming.reduce((s, d) => s + d.amount, 0);

  const monthly = new Map<string, { received: number; upcoming: number }>();
  for (const d of [...received, ...upcoming]) {
    const month = d.date.slice(0, 7);
    const m = monthly.get(month) ?? { received: 0, upcoming: 0 };
    if (d.status === 'RECEIVED') m.received += d.amount;
    else m.upcoming += d.amount;
    monthly.set(month, m);
  }

  return {
    baseCurrency: fx.base,
    totalReceived: round(received.reduce((s, d) => s + d.amount, 0)),
    last12Months: round(last12Months),
    projectedNext12Months: round(Math.max(last12Months, upcomingTotal)),
    // Round per payment only for display; totals above are summed from unrounded amounts.
    received: received.map((d) => ({ ...d, amount: round(d.amount) })),
    upcoming: upcoming.map((d) => ({ ...d, amount: round(d.amount) })),
    monthly: [...monthly.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, m]) => ({ month, received: round(m.received), upcoming: round(m.upcoming) })),
  };
}

export function historyRangeStart(range: '1M' | '3M' | '6M' | 'YTD' | '1Y' | 'ALL', today: string, firstTxnDate?: string): string {
  switch (range) {
    case '1M': return addDays(today, -30);
    case '3M': return addDays(today, -91);
    case '6M': return addDays(today, -182);
    case 'YTD': return `${today.slice(0, 4)}-01-01`;
    case '1Y': return addDays(today, -365);
    case 'ALL': return firstTxnDate ?? addDays(today, -365);
  }
}
