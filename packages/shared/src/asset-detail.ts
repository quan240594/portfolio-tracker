/**
 * Response builders for the asset detail endpoints. They take stored data (profile, quote, end-of-day closes,
 * dividend events, transactions, FX) and return exactly what the API sends, so the Lambda and the web demo's mock
 * backend share one implementation.
 */
import { addIsoDays, daysBetween, downsampleEvenly, roundTo } from './analytics.js';
import {
  ASSET_RANGES,
  DIVIDEND_GROWTH_YEARS,
  MAX_ASSET_POINTS,
  type AssetDetailResponse,
  type AssetDividendEvent,
  type AssetDividendReceived,
  type AssetDividends,
  type AssetDividendYear,
  type AssetHistoryResponse,
  type AssetMarker,
  type AssetPosition,
  type AssetPositionsResponse,
  type AssetPositionsTotals,
  type AssetPricePoint,
  type AssetProfileInfo,
  type AssetQuoteInfo,
  type AssetRange,
  type AssetStats,
  type ClosedSecurity,
  type GetClosedSecuritiesResponse,
} from './asset-detail-api.js';
import type { GrowthBenchmark, GrowthBenchmarkOption } from './growth-api.js';
import { FxTimeline, MissingFxRateError } from './fx.js';
import { isMarketSymbol } from './management-api.js';
import { buildPositions, calculatePortfolio, sortTransactions, txRate, type PortfolioResult } from './portfolio.js';
import type { DividendEvent, EodPrice, FxDay, FxRates, InstrumentProfile, Portfolio, Quote, Transaction } from './types.js';

const clean = (v: string | undefined): string | null => (v && v.trim() !== '' ? v : null);
const finite = (v: number | undefined): number | null => (v !== undefined && Number.isFinite(v) ? v : null);

/** Start date of a history range; `ALL` starts at `firstDate` (the earliest stored close). */
export function assetRangeStart(range: AssetRange, today: string, firstDate?: string): string {
  switch (range) {
    case '7D': return addIsoDays(today, -7);
    case '1M': return addIsoDays(today, -30);
    case '3M': return addIsoDays(today, -91);
    case '6M': return addIsoDays(today, -182);
    case 'YTD': return `${today.slice(0, 4)}-01-01`;
    case '1Y': return addIsoDays(today, -365);
    case '5Y': return addIsoDays(today, -1826);
    case 'ALL': return firstDate ?? addIsoDays(today, -365);
  }
}

export const isAssetRange = (v: unknown): v is AssetRange => (ASSET_RANGES as readonly unknown[]).includes(v);

/** Index and value of the smallest and largest non-null value; null for an empty series. First occurrence wins ties. */
export function seriesExtremes<T>(items: readonly T[], value: (item: T) => number | null): { min: { index: number; value: number } | null; max: { index: number; value: number } | null } {
  let min: { index: number; value: number } | null = null;
  let max: { index: number; value: number } | null = null;
  items.forEach((item, index) => {
    const v = value(item);
    if (v === null) return;
    if (min === null || v < min.value) min = { index, value: v };
    if (max === null || v > max.value) max = { index, value: v };
  });
  return { min, max };
}

// --- Dividends --------------------------------------------------------------------------------------

const eventsNewestFirst = (events: readonly DividendEvent[]): DividendEvent[] =>
  [...events].sort((a, b) => b.exDate.localeCompare(a.exDate));

function yearlyDividends(events: readonly DividendEvent[], today: string): AssetDividendYear[] {
  const totals = new Map<number, { perShare: number; payments: number }>();
  for (const e of events) {
    const year = Number(e.exDate.slice(0, 4));
    const t = totals.get(year) ?? { perShare: 0, payments: 0 };
    totals.set(year, { perShare: t.perShare + e.amount, payments: t.payments + 1 });
  }
  const years = [...totals.keys()].sort((a, b) => a - b);
  const currentYear = Number(today.slice(0, 4));
  return years.map((year, i) => {
    const t = totals.get(year)!;
    // The stored history starts at an arbitrary date, so the first year only counts as complete when it holds at
    // least as many payments as the (complete) year after it.
    const nextYear = years[i + 1];
    const next = nextYear === undefined || nextYear >= currentYear ? undefined : totals.get(nextYear);
    const startsComplete = i > 0 || (next !== undefined && t.payments >= next.payments);
    return { year, perShare: roundTo(t.perShare, 4), payments: t.payments, complete: year < currentYear && startsComplete };
  });
}

/** Trailing run of consecutive complete years (at most DIVIDEND_GROWTH_YEARS + 1 of them, newest last). */
function completeRun(byYear: readonly AssetDividendYear[]): AssetDividendYear[] {
  const run: AssetDividendYear[] = [];
  for (const y of byYear.filter((x) => x.complete).reverse()) {
    const newest = run[0];
    if (newest && newest.year - 1 !== y.year) break;
    run.unshift(y);
  }
  return run.slice(-(DIVIDEND_GROWTH_YEARS + 1));
}

function growthFigures(byYear: readonly AssetDividendYear[]): Pick<AssetStats, 'dividendGrowth' | 'dividendIncreaseStreak'> {
  const run = completeRun(byYear);
  const first = run[0];
  const last = run.at(-1);
  if (!first || !last || run.length < 2 || first.perShare <= 0) return { dividendGrowth: null, dividendIncreaseStreak: null };
  const years = run.length - 1;
  let streak = 0;
  for (let i = run.length - 1; i > 0 && run[i]!.perShare > run[i - 1]!.perShare; i--) streak++;
  return {
    dividendGrowth: { years, cagrPct: roundTo(((last.perShare / first.perShare) ** (1 / years) - 1) * 100, 2) },
    dividendIncreaseStreak: streak,
  };
}

export function buildAssetDividends(events: readonly DividendEvent[], today: string): AssetDividends {
  const sorted = eventsNewestFirst(events);
  const list: AssetDividendEvent[] = sorted.map((e) => ({ exDate: e.exDate, payDate: e.payDate ?? null, amount: e.amount }));
  return { currency: sorted[0]?.currency ?? null, events: list, byYear: yearlyDividends(sorted, today) };
}

type DividendStatKeys =
  | 'dividendYieldPct'
  | 'annualDividend'
  | 'nextExDate'
  | 'nextDividendAmount'
  | 'payoutRatioPct'
  | 'dividendGrowth'
  | 'dividendIncreaseStreak';

interface DividendStatInput {
  events: readonly DividendEvent[];
  dividends: AssetDividends;
  today: string;
  /** Latest price and its currency; null without a price. */
  price: { value: number; currency: string } | null;
  eps: number | null;
  profileCurrency: string;
}

/** Yield, annual payout, next ex-date, payout ratio, growth and streak from the stored dividend events. */
export function dividendStats({ events, dividends, today, price, eps, profileCurrency }: DividendStatInput): Pick<AssetStats, DividendStatKeys> {
  const yearAgo = addIsoDays(today, -365);
  const trailing = events.filter((e) => e.exDate > yearAgo && e.exDate <= today);
  const upcoming = [...events].filter((e) => e.exDate > today).sort((a, b) => a.exDate.localeCompare(b.exDate))[0];
  const annual = trailing.length > 0 ? roundTo(trailing.reduce((s, e) => s + e.amount, 0), 4) : null;
  const sameCurrency = (c: string) => dividends.currency === c;
  const yieldPct = annual !== null && price && price.value > 0 && sameCurrency(price.currency) ? roundTo((annual / price.value) * 100, 2) : null;
  const payout = annual !== null && eps !== null && eps > 0 && sameCurrency(profileCurrency) ? roundTo((annual / eps) * 100, 1) : null;
  return {
    dividendYieldPct: yieldPct,
    annualDividend: annual,
    nextExDate: upcoming?.exDate ?? null,
    nextDividendAmount: upcoming?.amount ?? null,
    payoutRatioPct: payout,
    ...growthFigures(dividends.byYear),
  };
}

// --- Detail -----------------------------------------------------------------------------------------

export interface AssetData {
  symbol: string;
  /** YYYY-MM-DD, the "current" day. */
  today: string;
  profile?: InstrumentProfile;
  quote?: Quote;
  /** Stored closes of the symbol, any order (only the newest few are needed for the detail). */
  eod: readonly EodPrice[];
  dividendEvents: readonly DividendEvent[];
  fx: FxRates;
  fxHistory?: readonly FxDay[];
}

const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);

function quoteInfo(data: AssetData): AssetQuoteInfo | null {
  const { quote, eod, fx } = data;
  const closes = [...eod].sort(byDate);
  const last = closes.at(-1);
  const previous = closes.at(-2);
  let basis: { source: 'quote' | 'eod'; price: number; previousClose: number; currency: string; asOf: string } | null = null;
  if (quote) basis = { source: 'quote', price: quote.price, previousClose: quote.previousClose, currency: quote.currency, asOf: quote.asOf };
  else if (last) basis = { source: 'eod', price: last.close, previousClose: (previous ?? last).close, currency: last.currency, asOf: last.date };
  if (!basis) return null;
  const change = basis.price - basis.previousClose;
  let priceBase: number | null = null;
  try {
    priceBase = roundTo(new FxTimeline(fx).toBase(basis.price, basis.currency), 4);
  } catch (err) {
    if (!(err instanceof MissingFxRateError)) throw err;
  }
  return {
    ...basis,
    change: roundTo(change, 4),
    changePct: basis.previousClose > 0 ? roundTo((change / basis.previousClose) * 100, 2) : 0,
    priceBase,
  };
}

function profileInfo(symbol: string, profile: InstrumentProfile | undefined, currency: string): AssetProfileInfo {
  return {
    symbol,
    name: profile?.name ?? symbol,
    assetClass: profile?.assetClass ?? 'OTHER',
    sector: clean(profile?.sector),
    country: clean(profile?.country),
    exchange: clean(profile?.exchange),
    currency: profile?.currency ?? currency,
    description: clean(profile?.description),
    isin: clean(profile?.isin),
  };
}

/** Null when nothing at all is stored for the symbol (the API answers 404). */
export function computeAssetDetail(data: AssetData): AssetDetailResponse | null {
  const { symbol, profile, today } = data;
  if (!profile && !data.quote && data.eod.length === 0) return null;
  const quote = quoteInfo(data);
  const currency = profile?.currency ?? quote?.currency ?? data.fx.base;
  const dividends = buildAssetDividends(data.dividendEvents, today);
  const eps = finite(profile?.eps);
  const stats: AssetStats = {
    peRatio: finite(profile?.peRatio),
    eps,
    beta: finite(profile?.beta),
    marketCap: finite(profile?.marketCap),
    ...dividendStats({ events: data.dividendEvents, dividends, today, price: quote ? { value: quote.price, currency: quote.currency } : null, eps, profileCurrency: currency }),
    nextEarningsDate: null,
  };
  return { symbol, baseCurrency: data.fx.base, profile: profileInfo(symbol, profile, currency), quote, stats, dividends };
}

// --- History ----------------------------------------------------------------------------------------

export interface AssetHistoryInput extends Omit<AssetData, 'dividendEvents'> {
  range: AssetRange;
  /** Transactions of the read scope (any symbol; others are ignored). */
  transactions: readonly Transaction[];
  /** The requested benchmarks with their stored closes, in request order. */
  benchmarks?: readonly { symbol: string; eod: readonly EodPrice[] }[];
  /** Selectable benchmarks, echoed in the response. */
  options?: readonly GrowthBenchmarkOption[];
}

const pctSince = (value: number, base: number): number => (base > 0 ? roundTo((value / base - 1) * 100, 2) : 0);

/** Benchmark closes carried forward over days it does not trade; null before its first close. */
function benchmarkCloses(dates: readonly string[], eod: readonly EodPrice[]): (number | null)[] {
  const closes = [...eod].sort(byDate);
  let next = 0;
  let current: number | null = null;
  return dates.map((date) => {
    while (next < closes.length && closes[next]!.date <= date) current = closes[next++]!.close;
    return current;
  });
}

function pricePoints(series: readonly EodPrice[]): AssetPricePoint[] {
  const first = series[0];
  return first ? series.map((p) => ({ date: p.date, close: p.close, pct: pctSince(p.close, first.close) })) : [];
}

function growthBenchmark(symbol: string, eod: readonly EodPrice[], dates: readonly string[]): GrowthBenchmark {
  const closes = benchmarkCloses(dates, eod);
  const base = closes.find((v) => v !== null) ?? null;
  return {
    symbol,
    available: eod.length > 0,
    ...(eod.length > 0 ? {} : { message: `No price history is stored for ${symbol}.` }),
    points: closes.map((value) => ({ value, returnPct: value !== null && base !== null ? pctSince(value, base) : null })),
    comparison: null,
  };
}

function snapToSeries(dates: readonly string[], date: string): string | null {
  return dates.find((d) => d >= date) ?? dates.at(-1) ?? null;
}

function markersOf(input: AssetHistoryInput, from: string, dates: readonly string[]): AssetMarker[] {
  const timeline = new FxTimeline(input.fx, input.fxHistory);
  const out: AssetMarker[] = [];
  for (const t of sortTransactions(input.transactions)) {
    if (t.symbol !== input.symbol || t.date < from || t.date > input.today) continue;
    if (t.type !== 'BUY' && t.type !== 'SELL' && t.type !== 'DIVIDEND') continue;
    const plotDate = snapToSeries(dates, t.date);
    if (plotDate === null) continue;
    const gross = t.quantity * t.price;
    const amount = t.type === 'BUY' ? gross + t.fee : gross - t.fee;
    out.push({
      date: t.date,
      plotDate,
      type: t.type,
      portfolioId: t.portfolioId,
      quantity: t.quantity,
      price: t.price,
      amountBase: roundTo(amount / txRate(t, timeline), 2),
    });
  }
  return out;
}

export function computeAssetHistory(input: AssetHistoryInput): AssetHistoryResponse {
  const sorted = [...input.eod].sort(byDate);
  const firstStored = sorted[0]?.date ?? null;
  const from = assetRangeStart(input.range, input.today, firstStored ?? undefined);
  const inRange = sorted.filter((p) => p.date >= from && p.date <= input.today);
  // Sample the dates once, so the benchmark series stay aligned with the price series.
  const sampled = downsampleEvenly(inRange, MAX_ASSET_POINTS);
  const points = pricePoints(sampled);
  const dates = points.map((p) => p.date);
  const currency = input.profile?.currency ?? input.quote?.currency ?? sorted.at(-1)?.currency ?? input.fx.base;
  return {
    symbol: input.symbol,
    range: input.range,
    baseCurrency: input.fx.base,
    currency,
    points,
    benchmarks: (input.benchmarks ?? []).map((b) => growthBenchmark(b.symbol, b.eod, dates)),
    options: [...(input.options ?? [])],
    markers: markersOf(input, from, dates),
    coverage: { from: firstStored, to: sorted.at(-1)?.date ?? null, limited: firstStored !== null && from < firstStored && input.range !== 'ALL' },
  };
}

// --- Positions --------------------------------------------------------------------------------------

export interface AssetPositionsInput {
  symbol: string;
  today: string;
  /** Transactions of the read scope (any symbol; others are ignored). */
  transactions: readonly Transaction[];
  profile?: InstrumentProfile;
  quote?: Quote;
  fx: FxRates;
  fxHistory?: readonly FxDay[];
  portfolios: readonly Pick<Portfolio, 'portfolioId' | 'name'>[];
  /** Total value (base currency) of each portfolio, the denominator of `weight`. */
  portfolioValues: Readonly<Record<string, number>>;
}

function groupByPortfolio(transactions: readonly Transaction[]): Map<string, Transaction[]> {
  const groups = new Map<string, Transaction[]>();
  for (const t of transactions) groups.set(t.portfolioId, [...(groups.get(t.portfolioId) ?? []), t]);
  return groups;
}

const tradeDates = (txns: readonly Transaction[]): { first: string | null; last: string | null } => {
  const dates = txns.filter((t) => t.type === 'BUY' || t.type === 'SELL').map((t) => t.date).sort((a, b) => a.localeCompare(b));
  return { first: dates[0] ?? null, last: dates.at(-1) ?? null };
};

/** Current holdings and summary of just this symbol's transactions, valued with the stored quote. */
function calculateSymbol(input: AssetPositionsInput, txns: readonly Transaction[]): PortfolioResult {
  const { symbol, profile, quote, fx, fxHistory } = input;
  return calculatePortfolio({
    transactions: txns,
    quotes: quote ? { [symbol]: quote } : {},
    profiles: profile ? { [symbol]: profile } : {},
    fx,
    fxHistory,
    now: new Date(`${input.today}T12:00:00Z`),
  });
}

function positionOf(input: AssetPositionsInput, portfolioId: string, txns: readonly Transaction[]): AssetPosition {
  const { holdings, summary } = calculateSymbol(input, txns);
  const holding = holdings[0];
  const capitalGain = (holding?.unrealizedPnl ?? 0) + summary.realizedPnl;
  const total = input.portfolioValues[portfolioId];
  const dates = tradeDates(txns);
  return {
    portfolioId,
    portfolioName: input.portfolios.find((p) => p.portfolioId === portfolioId)?.name ?? portfolioId,
    status: holding ? 'open' : 'closed',
    quantity: holding?.quantity ?? 0,
    averageCostBase: holding?.averageCostBase ?? 0,
    averageCostLocal: holding?.averageCostLocal ?? 0,
    costBasis: holding?.costBasis ?? 0,
    marketValue: holding?.marketValue ?? 0,
    unrealizedPnl: holding?.unrealizedPnl ?? 0,
    unrealizedPnlPct: holding?.unrealizedPnlPct ?? 0,
    realizedPnl: summary.realizedPnl,
    capitalGain: roundTo(capitalGain, 2),
    dividendsReceived: summary.dividendsReceived,
    profit: summary.totalReturn,
    profitPct: summary.totalReturnPct,
    weight: holding && total !== undefined && total > 0 ? roundTo(holding.marketValue / total, 4) : null,
    firstTradeDate: dates.first,
    lastTradeDate: dates.last,
  };
}

function receivedDividends(input: AssetPositionsInput, txns: readonly Transaction[]): AssetDividendReceived[] {
  const timeline = new FxTimeline(input.fx, input.fxHistory);
  return sortTransactions(txns)
    .filter((t) => t.type === 'DIVIDEND')
    .reverse()
    .map((t) => ({
      date: t.date,
      portfolioId: t.portfolioId,
      quantity: t.quantity,
      perShareLocal: t.price,
      currency: t.currency,
      amount: roundTo((t.quantity * t.price - t.fee) / txRate(t, timeline), 2),
    }));
}

function positionTotals(input: AssetPositionsInput, txns: readonly Transaction[]): AssetPositionsTotals {
  const { holdings, summary } = calculateSymbol(input, txns);
  const holding = holdings[0];
  return {
    quantity: holding?.quantity ?? 0,
    costBasis: holding?.costBasis ?? 0,
    marketValue: holding?.marketValue ?? 0,
    capitalGain: roundTo((holding?.unrealizedPnl ?? 0) + summary.realizedPnl, 2),
    dividendsReceived: summary.dividendsReceived,
    profit: summary.totalReturn,
    profitPct: summary.totalReturnPct,
  };
}

export function computeAssetPositions(input: AssetPositionsInput): AssetPositionsResponse {
  const own = input.transactions.filter((t) => t.symbol === input.symbol);
  const positions = [...groupByPortfolio(own)].map(([portfolioId, txns]) => positionOf(input, portfolioId, txns));
  positions.sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.marketValue - a.marketValue || a.portfolioName.localeCompare(b.portfolioName));
  return {
    symbol: input.symbol,
    baseCurrency: input.fx.base,
    currency: own[0]?.currency ?? input.profile?.currency ?? null,
    positions,
    totals: positions.length > 1 ? positionTotals(input, own) : null,
    received: receivedDividends(input, own),
  };
}

// --- Closed securities ------------------------------------------------------------------------------

export interface ClosedSecuritiesInput {
  /** Transactions of the read scope. */
  transactions: readonly Transaction[];
  profiles: Readonly<Record<string, InstrumentProfile>>;
  fx: FxRates;
  fxHistory?: readonly FxDay[];
}

/** Market symbols the user traded in the scope but no longer holds, with the result they realised. */
export function computeClosedSecurities({ transactions, profiles, fx, fxHistory }: ClosedSecuritiesInput): GetClosedSecuritiesResponse {
  const market = transactions.filter((t) => isMarketSymbol(t.symbol));
  const positions = buildPositions(market, undefined, new FxTimeline(fx, fxHistory));
  const securities: ClosedSecurity[] = [];
  for (const p of positions.values()) {
    if (p.quantity > 0) continue;
    const profile = profiles[p.symbol];
    const profit = p.realizedPnlBase + p.dividendsBase;
    securities.push({
      symbol: p.symbol,
      name: profile?.name ?? p.symbol,
      assetClass: profile?.assetClass ?? 'OTHER',
      sector: profile?.sector ?? 'Unknown',
      country: profile?.country ?? 'Unknown',
      currency: p.currency,
      realizedPnl: roundTo(p.realizedPnlBase, 2),
      dividendsReceived: roundTo(p.dividendsBase, 2),
      profit: roundTo(profit, 2),
      profitPct: p.investedBase > 0 ? roundTo((profit / p.investedBase) * 100, 2) : 0,
      lastSoldDate: market.filter((t) => t.symbol === p.symbol && t.type === 'SELL').map((t) => t.date).sort((a, b) => a.localeCompare(b)).at(-1) ?? null,
    });
  }
  securities.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { baseCurrency: fx.base, securities };
}

/** Days a quote may lag before the page calls it stale. */
export const ASSET_QUOTE_STALE_DAYS = 4;

/** Whether a quote/close dated `asOf` is older than ASSET_QUOTE_STALE_DAYS on `today`. */
export const isQuoteStale = (asOf: string, today: string): boolean => daysBetween(asOf.slice(0, 10), today) > ASSET_QUOTE_STALE_DAYS;
