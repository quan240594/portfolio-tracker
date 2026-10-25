import { FxTimeline, type FxLookup } from './fx.js';
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

/** Cash movements: they affect the cash ledger (management.ts) but never a position. */
const CASH_ONLY_TYPES: ReadonlySet<string> = new Set(['DEPOSIT', 'WITHDRAWAL', 'FEE', 'INTEREST']);

/**
 * A split affects every holding of the symbol, so the same split (symbol, date, ratio) entered in several portfolios
 * must count once when portfolios are combined. Expects chronologically sorted input.
 */
export function dropDuplicateSplits(sorted: readonly Transaction[]): Transaction[] {
  const seen = new Set<string>();
  return sorted.filter((t) => {
    if (t.type !== 'SPLIT') return true;
    const key = `${t.symbol}|${t.date}|${t.quantity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
export function txRate(t: Transaction, fx?: FxTimeline): number {
  if (!fx || t.currency === fx.base) return 1;
  return t.fxRate && t.fxRate > 0 ? t.fxRate : fx.rate(t.currency, t.date);
}

/** Replays transactions up to and including `asOfDate`, throws on overselling. */
export function buildPositions(txns: readonly Transaction[], asOfDate?: string, fx?: FxTimeline): Map<string, Position> {
  const positions = new Map<string, Position>();
  for (const t of dropDuplicateSplits(sortTransactions(txns))) {
    if (asOfDate && t.date > asOfDate) break;
    applyTransaction(positions, t, fx);
  }
  return positions;
}

/** Mutates `positions` by applying a single transaction (caller guarantees chronological order). */
export function applyTransaction(positions: Map<string, Position>, t: Transaction, fx?: FxTimeline): void {
  if (CASH_ONLY_TYPES.has(t.type)) return;
  let p = positions.get(t.symbol);
  if (t.type === 'SPLIT' && (!p || p.quantity <= 0 || Number.isNaN(t.quantity) || t.quantity <= 0)) {
    throw new PortfolioError(`Cannot split ${t.symbol} on ${t.date}: no position held or invalid ratio`);
  }
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
    case 'SPLIT': {
      // Total cost is unchanged: only the unit count (and thus the per-share average cost) changes.
      p.quantity *= t.quantity;
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

interface LastClose {
  close: number;
  date: string;
  currency: string;
}

interface DayClose {
  close: number;
  currency: string;
}

/** Closes before `start`: the latest one per symbol seeds the carry-forward. */
function seedLastClose(eod: Readonly<Record<string, readonly EodPrice[]>>, start: string): Map<string, LastClose> {
  const lastClose = new Map<string, LastClose>();
  for (const [symbol, prices] of Object.entries(eod)) {
    const prior = prices.filter((p) => p.date < start).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    if (prior) lastClose.set(symbol, { close: prior.close, date: prior.date, currency: prior.currency });
  }
  return lastClose;
}

interface SplitEvent {
  date: string;
  ratio: number;
}

/** Splits per symbol, for restating historical quantities on the basis of the (split-adjusted) provider prices. */
function splitsBySymbol(sorted: readonly Transaction[]): Map<string, SplitEvent[]> {
  const out = new Map<string, SplitEvent[]>();
  for (const t of sorted) {
    if (t.type !== 'SPLIT') continue;
    out.set(t.symbol, [...(out.get(t.symbol) ?? []), { date: t.date, ratio: t.quantity }]);
  }
  return out;
}

/** Product of the ratios of splits that happen after `date`: old units * factor = units on today's share basis. */
function futureSplitFactor(splits: readonly SplitEvent[] | undefined, date: string): number {
  return (splits ?? []).reduce((f, s) => (s.date > date ? f * s.ratio : f), 1);
}

/** The first and last day a symbol was valued at its average cost because no close was known. */
export interface CostValuedSpan {
  symbol: string;
  from: string;
  to: string;
}

/** Everything the daily valuation reads and keeps while it walks the days. */
interface Valuation {
  closeIndex: ReadonlyMap<string, ReadonlyMap<string, DayClose>>;
  lastClose: Map<string, LastClose>;
  timeline: FxTimeline;
  splits: ReadonlyMap<string, readonly SplitEvent[]>;
  /** The last day of the series: valued at the stored quote (the price of the headline) when there is one. */
  last: string;
  quotes: Readonly<Record<string, Quote>>;
  /** Days valued at cost per symbol. */
  atCost: Map<string, CostValuedSpan>;
  /** Symbols with an open position on at least one day of the series. */
  held: Set<string>;
  onPosition: ((line: ValuedPosition) => void) | undefined;
}

function noteCostValued(atCost: Map<string, CostValuedSpan>, symbol: string, date: string): void {
  const span = atCost.get(symbol);
  if (span) span.to = date;
  else atCost.set(symbol, { symbol, from: date, to: date });
}

/**
 * The quote that values `symbol` on the last day, or undefined: the same one the headline uses (`calculatePortfolio`), as long as it
 * is not older than the last known close (a provider's close of a later day is the newer price).
 */
function liveQuote(valuation: Valuation, symbol: string, date: string): Quote | undefined {
  const quote = valuation.quotes[symbol];
  if (!quote || date !== valuation.last) return undefined;
  return quote.asOf.slice(0, 10) >= (valuation.lastClose.get(symbol)?.date ?? '') ? quote : undefined;
}

/** Where the price of a valued position comes from: that day's close, an older close carried forward, the live quote or the average cost. */
export type ValuationSource = 'close' | 'carried' | 'quote' | 'cost';

/** One open position valued on one day of a value series (what `ValueSeriesInput.onPosition` receives). */
export interface ValuedPosition {
  date: string;
  symbol: string;
  /** Currency the position is held in. */
  currency: string;
  /** Units on today's share basis (restated for later splits). */
  units: number;
  source: ValuationSource;
  /** Price per unit as used, in `priceCurrency`. */
  price: number;
  priceCurrency: string;
  /** Date of the close used; null for the average cost, and the date of the quote for a live quote. */
  priceDate: string | null;
  /** The rate that converted the value into the base currency, with its fixing date and why it is not that day's. */
  fx: FxLookup;
  /** Market value in the base currency. */
  value: number;
  /** Cost basis in the base currency. */
  cost: number;
}

/** Market value and cost basis (base currency) of the open positions on `date`; updates `lastClose`. */
function valuePositionsOn(positions: ReadonlyMap<string, Position>, valuation: Valuation, date: string): { value: number; invested: number } {
  let value = 0;
  let invested = 0;
  for (const p of positions.values()) {
    const close = valuation.closeIndex.get(p.symbol)?.get(date);
    if (close !== undefined) valuation.lastClose.set(p.symbol, { ...close, date });
    if (p.quantity <= 0) continue;
    valuation.held.add(p.symbol);
    // Provider closes are split-adjusted (as if the latest share basis always applied), so units held before a
    // later split are restated to today's basis; the fallback price (cost / units) uses the same basis.
    const units = p.quantity * futureSplitFactor(valuation.splits.get(p.symbol), date);
    const price = priceOf(valuation, p, units, date);
    const fx = valuation.timeline.lookup(price.currency, price.fxDate);
    const positionValue = (units * price.value) / fx.rate;
    value += positionValue;
    invested += p.costBase;
    valuation.onPosition?.({ date, symbol: p.symbol, currency: p.currency, units, source: price.source, price: price.value, priceCurrency: price.currency, priceDate: price.date, fx, value: positionValue, cost: p.costBase });
  }
  return { value, invested };
}

interface PriceUsed {
  source: ValuationSource;
  value: number;
  currency: string;
  date: string | null;
  /** The day whose FX fixing converts it (undefined: the latest rate, as the headline does). */
  fxDate: string | undefined;
}

/** The price that values a position on `date`: the live quote on the last day, else the last known close, else the average cost. */
function priceOf(valuation: Valuation, p: Position, units: number, date: string): PriceUsed {
  const quote = liveQuote(valuation, p.symbol, date);
  if (quote) return { source: 'quote', value: quote.price, currency: quote.currency, date: quote.asOf.slice(0, 10), fxDate: undefined };
  const known = valuation.lastClose.get(p.symbol);
  if (!known) {
    noteCostValued(valuation.atCost, p.symbol, date);
    return { source: 'cost', value: p.costLocal / units, currency: p.currency, date: null, fxDate: date };
  }
  // The close is valued in the currency of its own row, which is not always the one the position is held in.
  return { source: known.date === date ? 'close' : 'carried', value: known.close, currency: known.currency, date: known.date, fxDate: date };
}

/** Extra value/cost on a date that does not come from positions (cash balances, custom assets). */
export type ValueHistoryExtra = (date: string, timeline: FxTimeline) => { value: number; invested: number };

export interface ValueSeriesInput {
  transactions: readonly Transaction[];
  eod: Readonly<Record<string, readonly EodPrice[]>>;
  fx: FxRates;
  from: string;
  to: string;
  fxHistory?: readonly FxDay[];
  extra?: ValueHistoryExtra;
  /** Latest stored quote per symbol: on the last day (`to`) a position is valued at it, like the headline total. */
  quotes?: Readonly<Record<string, Quote>>;
  /** Called for every open position on every day with how it was valued (the chart reconciliation reads it). */
  onPosition?: (line: ValuedPosition) => void;
}

export interface ValueSeries {
  points: ValuePoint[];
  /** Symbols that were valued at average cost on some days because no close was stored yet, with those days. */
  costValued: CostValuedSpan[];
  /** Symbols with an open position on at least one day of the series. */
  held: number;
}

/**
 * Daily portfolio value series between `from` and `to` (inclusive) in the base currency, with the symbols that had to be valued at cost.
 * Each day's value uses that day's ECB fixing (carried over weekends/holidays) when `fxHistory` is
 * given, else the latest rate; `invested` is the cost basis at the purchase-date rates.
 * Missing closes carry forward the last known close, falling back to the position's average cost.
 * The last day uses the latest stored quote of each position (when given and not older than the last close) at the latest FX rate:
 * exactly what the headline total is made of.
 * Assumption: EOD closes are split-adjusted (Yahoo-style), so quantities held before a SPLIT are shown multiplied by the
 * split ratio; the value therefore does not jump on the split date. `extra` adds cash/custom-asset value and cost.
 */
export function buildValueSeries({ transactions, eod, fx, from, to, fxHistory, extra, quotes = {}, onPosition }: Readonly<ValueSeriesInput>): ValueSeries {
  const sorted = dropDuplicateSplits(sortTransactions(transactions));
  if (sorted.length === 0 || from > to) return { points: [], costValued: [], held: 0 };
  const timeline = new FxTimeline(fx, fxHistory);
  const start = from < sorted[0]!.date ? sorted[0]!.date : from;

  const closeIndex = new Map<string, Map<string, DayClose>>();
  for (const [symbol, prices] of Object.entries(eod)) {
    closeIndex.set(symbol, new Map(prices.map((p) => [p.date, { close: p.close, currency: p.currency }])));
  }

  const valuation: Valuation = { closeIndex, lastClose: seedLastClose(eod, start), timeline, splits: splitsBySymbol(sorted), last: to, quotes, atCost: new Map(), held: new Set(), onPosition };
  const points: ValuePoint[] = [];
  const positions = new Map<string, Position>();
  let next = 0;
  for (let date = start; date <= to; date = addDays(date, 1)) {
    while (next < sorted.length && sorted[next]!.date <= date) applyTransaction(positions, sorted[next++]!, timeline);
    const held = valuePositionsOn(positions, valuation, date);
    const added = extra?.(date, timeline) ?? { value: 0, invested: 0 };
    points.push({ date, value: round(held.value + added.value), invested: round(held.invested + added.invested) });
  }
  return { points, costValued: [...valuation.atCost.values()], held: valuation.held.size };
}

/**
 * Daily portfolio value series between `from` and `to` (inclusive) in the base currency: `buildValueSeries` without live quotes
 * (every day, the last one included, is valued at the last known close).
 */
export function buildValueHistory(
  transactions: readonly Transaction[],
  eod: Readonly<Record<string, readonly EodPrice[]>>,
  fx: FxRates,
  from: string,
  to: string,
  fxHistory?: readonly FxDay[],
  extra?: ValueHistoryExtra,
): ValuePoint[] {
  return buildValueSeries({ transactions, eod, fx, from, to, fxHistory, extra }).points;
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
