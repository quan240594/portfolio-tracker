import { toBase } from './fx.js';
import type {
  AllocationDimension,
  AllocationSlice,
  Currency,
  DividendEvent,
  DividendOverview,
  DividendPayment,
  EodPrice,
  FxRates,
  Holding,
  InstrumentProfile,
  IsoDate,
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

/** Per-symbol position state in the instrument's local currency (average-cost method). */
export interface Position {
  symbol: string;
  currency: Currency;
  quantity: number;
  costLocal: number;
  realizedPnlLocal: number;
  dividendsLocal: number;
}

/** Replays transactions up to and including `asOfDate` (inclusive), throws on overselling. */
export function buildPositions(txns: readonly Transaction[], asOfDate?: IsoDate): Map<string, Position> {
  const positions = new Map<string, Position>();
  for (const t of sortTransactions(txns)) {
    if (asOfDate && t.date > asOfDate) break;
    let p = positions.get(t.symbol);
    if (!p) {
      p = { symbol: t.symbol, currency: t.currency, quantity: 0, costLocal: 0, realizedPnlLocal: 0, dividendsLocal: 0 };
      positions.set(t.symbol, p);
    }
    if (t.currency !== p.currency) {
      throw new PortfolioError(`Mixed currencies for ${t.symbol}: ${p.currency} and ${t.currency}`);
    }
    switch (t.type) {
      case 'BUY':
        p.quantity += t.quantity;
        p.costLocal += t.quantity * t.price + t.fee;
        break;
      case 'SELL': {
        if (t.quantity > p.quantity + EPSILON) {
          throw new PortfolioError(`Cannot sell ${t.quantity} ${t.symbol} on ${t.date}: only ${p.quantity} held`);
        }
        const avg = p.quantity > 0 ? p.costLocal / p.quantity : 0;
        p.realizedPnlLocal += t.quantity * t.price - t.fee - avg * t.quantity;
        p.costLocal -= avg * t.quantity;
        p.quantity -= t.quantity;
        if (p.quantity < EPSILON) {
          p.quantity = 0;
          p.costLocal = 0;
        }
        break;
      }
      case 'DIVIDEND':
        p.dividendsLocal += t.quantity * t.price - t.fee;
        break;
    }
  }
  return positions;
}

export interface PortfolioInput {
  transactions: readonly Transaction[];
  quotes: Readonly<Record<string, Quote>>;
  profiles: Readonly<Record<string, InstrumentProfile>>;
  fx: FxRates;
  now?: Date;
}

export interface PortfolioResult {
  summary: PortfolioSummary;
  holdings: Holding[];
}

/**
 * Computes current holdings and summary. Cost basis is converted with the *current* FX rate
 * (no historical FX), so currency effects are not separated from price returns in v1.
 * Holdings that are fully sold are excluded from `holdings` but their realized P&L and dividends
 * still count in the summary.
 */
export function calculatePortfolio({ transactions, quotes, profiles, fx, now = new Date() }: PortfolioInput): PortfolioResult {
  const positions = buildPositions(transactions);
  const holdings: Holding[] = [];
  let realizedPnl = 0;
  let dividendsReceived = 0;

  for (const p of positions.values()) {
    const realized = toBase(p.realizedPnlLocal, p.currency, fx);
    const dividends = toBase(p.dividendsLocal, p.currency, fx);
    realizedPnl += realized;
    dividendsReceived += dividends;
    if (p.quantity <= 0) continue;

    const quote = quotes[p.symbol];
    const profile = profiles[p.symbol];
    const avgLocal = p.costLocal / p.quantity;
    const priceLocal = quote?.price ?? avgLocal;
    const prevLocal = quote?.previousClose ?? priceLocal;
    const priceCurrency = quote?.currency ?? p.currency;

    const marketValue = toBase(p.quantity * priceLocal, priceCurrency, fx);
    const costBasis = toBase(p.costLocal, p.currency, fx);
    const dayChange = toBase(p.quantity * (priceLocal - prevLocal), priceCurrency, fx);
    const prevValue = marketValue - dayChange;

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
      priceStale: !quote,
      costBasis: round(costBasis),
      marketValue: round(marketValue),
      unrealizedPnl: round(marketValue - costBasis),
      unrealizedPnlPct: pct(marketValue - costBasis, costBasis),
      dayChange: round(dayChange),
      dayChangePct: pct(dayChange, prevValue),
      realizedPnl: round(realized),
      dividendsReceived: round(dividends),
      weight: 0,
    });
  }

  const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const totalCost = holdings.reduce((s, h) => s + h.costBasis, 0);
  const dayChange = holdings.reduce((s, h) => s + h.dayChange, 0);
  for (const h of holdings) h.weight = totalValue > 0 ? round(h.marketValue / totalValue, 4) : 0;
  holdings.sort((a, b) => b.marketValue - a.marketValue);

  const unrealizedPnl = totalValue - totalCost;
  const totalReturn = unrealizedPnl + realizedPnl + dividendsReceived;
  const invested = sumBuys(transactions, fx);

  return {
    holdings,
    summary: {
      baseCurrency: fx.base,
      totalValue: round(totalValue),
      totalCost: round(totalCost),
      unrealizedPnl: round(unrealizedPnl),
      unrealizedPnlPct: pct(unrealizedPnl, totalCost),
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

function sumBuys(txns: readonly Transaction[], fx: FxRates): number {
  return txns
    .filter((t) => t.type === 'BUY')
    .reduce((s, t) => s + toBase(t.quantity * t.price + t.fee, t.currency, fx), 0);
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

const addDays = (date: IsoDate, days: number): IsoDate => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Daily portfolio value series between `from` and `to` (inclusive) using EOD closes.
 * Missing closes carry forward the last known close (weekends/holidays), falling back to the
 * position's average cost. Values are converted at current FX (see calculatePortfolio).
 */
export function buildValueHistory(
  transactions: readonly Transaction[],
  eod: Readonly<Record<string, readonly EodPrice[]>>,
  fx: FxRates,
  from: IsoDate,
  to: IsoDate,
): ValuePoint[] {
  const sorted = sortTransactions(transactions);
  if (sorted.length === 0 || from > to) return [];
  const start = from < sorted[0]!.date ? sorted[0]!.date : from;

  const closeIndex = new Map<string, Map<IsoDate, number>>();
  for (const [symbol, prices] of Object.entries(eod)) {
    closeIndex.set(symbol, new Map(prices.map((p) => [p.date, p.close])));
  }

  const lastClose = new Map<string, number>();
  // Seed carry-forward closes from before `start`.
  for (const [symbol, prices] of Object.entries(eod)) {
    const prior = prices.filter((p) => p.date < start).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    if (prior) lastClose.set(symbol, prior.close);
  }

  const points: ValuePoint[] = [];
  for (let date = start; date <= to; date = addDays(date, 1)) {
    const positions = buildPositions(sorted, date);
    let value = 0;
    let invested = 0;
    for (const p of positions.values()) {
      const close = closeIndex.get(p.symbol)?.get(date);
      if (close !== undefined) lastClose.set(p.symbol, close);
      if (p.quantity <= 0) continue;
      const price = lastClose.get(p.symbol) ?? p.costLocal / p.quantity;
      value += toBase(p.quantity * price, p.currency, fx);
      invested += toBase(p.costLocal, p.currency, fx);
    }
    points.push({ date, value: round(value), invested: round(invested) });
  }
  return points;
}

/**
 * Received = DIVIDEND transactions. Upcoming = announced DividendEvents with exDate > today
 * multiplied by the current quantity held (gross, no withholding tax estimate).
 * Projection for the next 12 months = trailing-12-month received (simple run-rate) or upcoming, whichever is higher.
 */
export function calculateDividends(
  transactions: readonly Transaction[],
  events: readonly DividendEvent[],
  fx: FxRates,
  today: IsoDate = new Date().toISOString().slice(0, 10),
): DividendOverview {
  const received: DividendPayment[] = sortTransactions(transactions)
    .filter((t) => t.type === 'DIVIDEND')
    .map((t) => ({
      symbol: t.symbol,
      date: t.date,
      perShareLocal: t.price,
      currency: t.currency,
      amount: round(toBase(t.quantity * t.price - t.fee, t.currency, fx)),
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
      amount: round(toBase(positions.get(e.symbol)!.quantity * e.amount, e.currency, fx)),
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
    received,
    upcoming,
    monthly: [...monthly.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, m]) => ({ month, received: round(m.received), upcoming: round(m.upcoming) })),
  };
}

export function historyRangeStart(range: '1M' | '3M' | '6M' | 'YTD' | '1Y' | 'ALL', today: IsoDate, firstTxnDate?: IsoDate): IsoDate {
  switch (range) {
    case '1M': return addDays(today, -30);
    case '3M': return addDays(today, -91);
    case '6M': return addDays(today, -182);
    case 'YTD': return `${today.slice(0, 4)}-01-01`;
    case '1Y': return addDays(today, -365);
    case 'ALL': return firstTxnDate ?? addDays(today, -365);
  }
}
