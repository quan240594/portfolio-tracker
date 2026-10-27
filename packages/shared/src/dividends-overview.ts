/**
 * Aggregates behind the Dividends page (`GET /dividends/overview`): forward income and yield per holding, a
 * future-payments calendar split into declared and estimated, per-share growth and a payment-consistency score.
 * Everything is derived from the user's own transactions and the stored dividend events; no company fundamentals.
 */
import { FxTimeline } from './fx.js';
import { addIsoDays, daysBetween, DAYS_PER_YEAR, ratioToPct, roundTo, transactionAmount } from './analytics.js';
import { calculatePassiveIncome, paymentsPerYear, type PassiveIncome, type PassiveIncomeHolding } from './analytics-income.js';
import type { AnalyticsData } from './analytics-compute.js';
import { calculatePortfolio } from './portfolio.js';
import type { AssetClass, DividendEvent, Holding, Transaction } from './types.js';

export const DIVIDENDS_ROUTES = {
  dividendsOverview: 'GET /dividends/overview',
} as const;

// --- Consistency score definition (documented in docs/architecture.md and shown in the UI) ----------

export const CONSISTENCY_BADGES = ['RELIABLE', 'OK', 'IRREGULAR', 'NEW'] as const;
export type ConsistencyBadge = (typeof CONSISTENCY_BADGES)[number];

/** Maximum points per component; they add up to 100. */
export const CONSISTENCY_WEIGHTS = { history: 30, regularity: 30, cuts: 25, growth: 15 } as const;
/** Fewer known payments than this → badge NEW and no score. */
export const CONSISTENCY_MIN_PAYMENTS = 2;
export const CONSISTENCY_RELIABLE_FROM = 70;
export const CONSISTENCY_OK_FROM = 40;
/** History: 12-month periods with a payment that earn full points. */
export const CONSISTENCY_FULL_HISTORY_YEARS = 5;
/** Regularity: variation of the gaps between payments up to which the schedule counts as perfectly regular / not regular at all. */
export const CONSISTENCY_FULL_CV = 0.05;
export const CONSISTENCY_ZERO_CV = 0.5;
/** Points lost per cut (a year with a lower per-share total than the year before). */
export const CONSISTENCY_CUT_PENALTY = 13;
/** Neutral points where the history is too short to judge regularity (< 3 payments) or cuts (< 2 full years). */
export const CONSISTENCY_NEUTRAL = { regularity: 15, cuts: 12 } as const;
/** Growth: consecutive yearly raises that earn full points. */
export const CONSISTENCY_FULL_STREAK = 5;
/** Year-over-year changes within ±0.5 % count as flat (rounding of per-share amounts). */
export const FLAT_BAND = 0.005;
/** Longer than 1.5 × the usual gap without a payment counts as one more (irregular) gap. */
const OVERDUE_FACTOR = 1.5;
/** A past event within this many days of a received payment is the same payment. */
const SAME_PAYMENT_DAYS = 20;
/** Years of per-share growth looked at (blocks of payments, newest first). */
const MAX_BLOCKS = 6;
const MONTHS = 12;

export interface PaymentPoint {
  date: string;
  /** Gross dividend per share in the paying currency. */
  perShare: number;
}

export interface ConsistencyPoints {
  history: number;
  regularity: number;
  cuts: number;
  growth: number;
}

export interface ConsistencyScore {
  badge: ConsistencyBadge;
  /** 0-100, null for badge NEW. */
  score: number | null;
  payments: number;
  /** 12-month periods (counted back from today, at most 5) with at least one payment. */
  yearsWithPayments: number;
  /** 1, 2, 4 or 12: implied by the gaps between the latest payments. */
  paymentsPerYear: number;
  /** Variation (standard deviation / mean) of the gaps between payments; null with fewer than 3 payments. */
  regularityCv: number | null;
  /** Years with a lower per-share total than the year before; null without two full years of payments. */
  cuts: number | null;
  /** Consecutive years (newest first) in which the per-share total went up. */
  growthStreak: number;
  points: ConsistencyPoints;
}

const sum = (values: readonly number[]): number => values.reduce((s, v) => s + v, 0);
const byDate = (a: PaymentPoint, b: PaymentPoint): number => a.date.localeCompare(b.date);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The known dividend history of one symbol: the payments the user received plus past dividend events (the data
 * provider covers about two years) that are not one of those payments. Oldest first.
 */
export function mergePaymentHistory(received: readonly PaymentPoint[], events: readonly DividendEvent[], today: string): PaymentPoint[] {
  const known = [...received];
  for (const e of events) {
    const date = e.payDate ?? e.exDate;
    if (date > today || known.some((p) => Math.abs(daysBetween(p.date, date)) <= SAME_PAYMENT_DAYS)) continue;
    known.push({ date, perShare: e.amount });
  }
  return [...known].sort(byDate);
}

/** Per-share sums of consecutive blocks of `size` payments, newest block first. An incomplete oldest block is dropped. */
export function paymentBlocks(payments: readonly PaymentPoint[], size: number): number[] {
  const blocks: number[] = [];
  for (let end = payments.length; end - size >= 0 && blocks.length < MAX_BLOCKS; end -= size) {
    blocks.push(roundTo(sum(payments.slice(end - size, end).map((p) => p.perShare)), 4));
  }
  return blocks;
}

/** Number of consecutive blocks (newest first) that went up compared with the block before. */
function growthStreak(blocks: readonly number[]): number {
  let streak = 0;
  while (streak + 1 < blocks.length && blocks[streak]! > blocks[streak + 1]! * (1 + FLAT_BAND)) streak++;
  return streak;
}

function countCuts(blocks: readonly number[]): number {
  return blocks.slice(0, -1).filter((b, i) => b < blocks[i + 1]! * (1 - FLAT_BAND)).length;
}

/** Compound annual growth (%) of the per-share dividend over the full years known; null with fewer than two. */
export function dividendGrowthCagr(payments: readonly PaymentPoint[]): { cagrPct: number | null; years: number } {
  if (payments.length < CONSISTENCY_MIN_PAYMENTS) return { cagrPct: null, years: 0 };
  const blocks = paymentBlocks(payments, paymentsPerYear(payments.map((p) => p.date)));
  const years = blocks.length - 1;
  const oldest = blocks.at(-1) ?? 0;
  if (years < 1 || oldest <= 0) return { cagrPct: null, years: Math.max(years, 0) };
  return { cagrPct: ratioToPct((blocks[0]! / oldest) ** (1 / years) - 1), years };
}

function yearsWithPayments(dates: readonly string[], today: string): number {
  let years = 0;
  for (let k = 0; k < CONSISTENCY_FULL_HISTORY_YEARS; k++) {
    const end = addIsoDays(today, -DAYS_PER_YEAR * k);
    const start = addIsoDays(end, -DAYS_PER_YEAR);
    if (dates.some((d) => d > start && d <= end)) years++;
  }
  return years;
}

/** Gaps in days between consecutive payments, plus the open gap since the last one when it is overdue. */
function paymentGaps(dates: readonly string[], today: string): number[] {
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i]!, d));
  const open = daysBetween(dates.at(-1)!, today);
  return open > OVERDUE_FACTOR * median(gaps) ? [...gaps, open] : gaps;
}

function variation(values: readonly number[]): number {
  const mean = sum(values) / values.length;
  const variance = sum(values.map((v) => (v - mean) ** 2)) / values.length;
  return Math.sqrt(variance) / mean;
}

function regularity(dates: readonly string[], today: string): { cv: number | null; points: number } {
  const gaps = paymentGaps(dates, today);
  if (gaps.length < 2) return { cv: null, points: CONSISTENCY_NEUTRAL.regularity };
  const cv = variation(gaps);
  const spread = Math.min(Math.max((cv - CONSISTENCY_FULL_CV) / (CONSISTENCY_ZERO_CV - CONSISTENCY_FULL_CV), 0), 1);
  return { cv: roundTo(cv, 3), points: Math.round(CONSISTENCY_WEIGHTS.regularity * (1 - spread)) };
}

const NEW_POINTS: ConsistencyPoints = { history: 0, regularity: 0, cuts: 0, growth: 0 };

/**
 * Payment-consistency score (0-100) of one symbol from its payment history; see docs/architecture.md.
 *
 * - history (30): 6 points per 12-month period (counted back from today, at most 5) with a payment
 * - regularity (30): the gaps between payments (and an overdue open gap) should be equal: 30 at a variation
 *   ≤ 0.05, falling linearly to 0 at 0.5; 15 with fewer than 3 payments
 * - cuts (25): 25 minus 13 per year whose per-share total is lower than the year before; 12 without two full years
 * - growth (15): 3 points per consecutive year (newest first) with a higher per-share total, at most 5
 *
 * Badges: RELIABLE ≥ 70, OK 40-69, IRREGULAR < 40, NEW with fewer than 2 payments (no score).
 */
export function scoreConsistency(payments: readonly PaymentPoint[], today: string): ConsistencyScore {
  const dates = payments.map((p) => p.date);
  if (payments.length < CONSISTENCY_MIN_PAYMENTS) {
    return { badge: 'NEW', score: null, payments: payments.length, yearsWithPayments: yearsWithPayments(dates, today), paymentsPerYear: 1, regularityCv: null, cuts: null, growthStreak: 0, points: NEW_POINTS };
  }
  const perYear = paymentsPerYear(dates);
  const blocks = paymentBlocks(payments, perYear);
  const years = yearsWithPayments(dates, today);
  const reg = regularity(dates, today);
  const cuts = blocks.length >= 2 ? countCuts(blocks) : null;
  const streak = growthStreak(blocks);
  const points: ConsistencyPoints = {
    history: Math.round((CONSISTENCY_WEIGHTS.history * Math.min(years, CONSISTENCY_FULL_HISTORY_YEARS)) / CONSISTENCY_FULL_HISTORY_YEARS),
    regularity: reg.points,
    cuts: cuts === null ? CONSISTENCY_NEUTRAL.cuts : Math.max(0, CONSISTENCY_WEIGHTS.cuts - CONSISTENCY_CUT_PENALTY * cuts),
    growth: Math.round((CONSISTENCY_WEIGHTS.growth * Math.min(streak, CONSISTENCY_FULL_STREAK)) / CONSISTENCY_FULL_STREAK),
  };
  const score = points.history + points.regularity + points.cuts + points.growth;
  return { badge: badgeFor(score), score, payments: payments.length, yearsWithPayments: years, paymentsPerYear: perYear, regularityCv: reg.cv, cuts, growthStreak: streak, points };
}

export function badgeFor(score: number): ConsistencyBadge {
  if (score >= CONSISTENCY_RELIABLE_FROM) return 'RELIABLE';
  return score >= CONSISTENCY_OK_FROM ? 'OK' : 'IRREGULAR';
}

// --- Response ----------------------------------------------------------------------------------------

export interface DividendOverviewHolding {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** Paying currency; per-share amounts are in this currency, everything else in the base currency. */
  currency: string;
  marketValue: number;
  costBasis: number;
  /** Net income expected over the next 12 months (declared + estimated); 0 when nothing is expected. */
  forward12m: number;
  declared: number;
  estimated: number;
  /** Share of the portfolio's forward income, percent. */
  sharePct: number;
  yieldPct: number;
  yieldOnCostPct: number;
  /** Net received in the last 12 months / ever. */
  received12m: number;
  receivedTotal: number;
  /** Compound annual growth of the dividend per share, percent; null without two full years of payments. */
  growthPct: number | null;
  growthYears: number;
  consistency: ConsistencyScore;
}

export interface DividendOverviewSummary {
  forward12m: number;
  declared: number;
  estimated: number;
  /** Forward income / 12. */
  monthlyAverage: number;
  yieldOnValuePct: number;
  yieldOnCostPct: number;
  /** Net received in the 12 months up to today. */
  last12m: number;
  /** Forward 12-month income compared with `last12m`, percent; null when nothing was received in the last 12 months. */
  growthVsLast12mPct: number | null;
  /** Net received in the 12 months before `last12m` (days 366 to 730 back). */
  previous12m: number;
  /** Trailing growth: `last12m` compared with `previous12m`, percent; null when nothing was received in `previous12m`. */
  ttmGrowthPct: number | null;
  /** True when the first dividend ever received is inside the previous 12 months, so that period is only partly covered by your history. */
  previous12mPartial: boolean;
  /** Trailing yield: `last12m` / current market value, percent (0 without market value). */
  ttmYieldOnValuePct: number;
  /** Trailing yield: `last12m` / cost basis, percent (0 without cost basis). */
  ttmYieldOnCostPct: number;
  /** Holdings that paid a dividend in the last 12 months. */
  ttmPayers: number;
}

export interface FutureMonth {
  /** YYYY-MM, 12 consecutive months starting with the current one; a payment in the same month a year ahead counts in the first. */
  month: string;
  declared: number;
  estimated: number;
}

/** Declared and estimated forward income of one holding in one future month (zero amounts are left out). */
export interface FutureHoldingAmount {
  /** YYYY-MM, one of the `futureMonths`. */
  month: string;
  symbol: string;
  declared: number;
  estimated: number;
}

export interface DividendsOverviewResponse {
  baseCurrency: string;
  asOf: string;
  summary: DividendOverviewSummary;
  /** Current holdings that pay (or paid) dividends, largest forward income first. */
  holdings: DividendOverviewHolding[];
  /** Forward income by month: the declared part sums with the estimated part to `summary.forward12m`. */
  futureMonths: FutureMonth[];
  /**
   * Optional (older responses lack it; clients hide the per-holding breakdown then): the same forward income per holding
   * and month, ordered by month then symbol. Amounts are rounded per entry, so a month's entries can differ from its
   * `futureMonths` total by a few cents.
   */
  futureByHolding?: FutureHoldingAmount[];
}

type EventsBySymbol = ReadonlyMap<string, readonly DividendEvent[]>;

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    out.set(key, [...(out.get(key) ?? []), item]);
  }
  return out;
}

/** Dividend transactions of one symbol as per-share payments, one point per day. */
function receivedPoints(transactions: readonly Transaction[]): PaymentPoint[] {
  const perDay = new Map<string, number>();
  for (const t of transactions) perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.price);
  return [...perDay.entries()].map(([date, perShare]) => ({ date, perShare })).sort(byDate);
}

// --- Future months -----------------------------------------------------------------------------------

function monthKeys(today: string): string[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return Array.from({ length: MONTHS }, (_, i) => {
    const index = y * MONTHS + (m - 1) + i;
    return `${Math.floor(index / MONTHS)}-${String((index % MONTHS) + 1).padStart(2, '0')}`;
  });
}

/** Index of the month bucket of a date. The window is 365 days, so a date in its 13th month shares the bucket of the current month. */
function monthIndex(date: string, firstMonth: string): number {
  const [y0, m0] = firstMonth.split('-').map(Number) as [number, number];
  const [y, m] = date.split('-').map(Number) as [number, number];
  const offset = (y - y0) * MONTHS + (m - m0);
  return ((offset % MONTHS) + MONTHS) % MONTHS;
}

/** Index of the slot closest to `date`, or -1 when none is within `maxGap` days. */
function nearestSlot(slots: readonly string[], date: string, maxGap: number): number {
  let best = -1;
  let bestGap = maxGap;
  slots.forEach((slot, i) => {
    const gap = Math.abs(daysBetween(slot, date));
    if (gap <= bestGap) {
      best = i;
      bestGap = gap;
    }
  });
  return best;
}

/** Expected pay dates of the not yet announced payments: last year's schedule shifted a year, minus the slots announced events fill. */
function estimatedDates(latest: string, perYear: number, declaredDates: readonly string[], count: number, today: string): string[] {
  const interval = DAYS_PER_YEAR / perYear;
  const horizon = addIsoDays(today, DAYS_PER_YEAR);
  const anchor = addIsoDays(latest, DAYS_PER_YEAR);
  let slots = Array.from({ length: perYear }, (_, j) => {
    const date = addIsoDays(anchor, Math.round(j * interval));
    return date > horizon ? addIsoDays(date, -DAYS_PER_YEAR) : date;
  }).sort((a, b) => a.localeCompare(b));
  for (const declared of declaredDates) {
    const taken = nearestSlot(slots, declared, interval / 2);
    slots = slots.filter((_, i) => i !== taken);
  }
  return slots.slice(0, count);
}

interface ScheduledAmount {
  date: string;
  amount: number;
}

interface HoldingSchedule {
  declared: ScheduledAmount[];
  estimated: ScheduledAmount[];
}

/** Spreads a holding's declared and estimated forward income over the pay dates they come from. */
function holdingSchedule(
  income: PassiveIncomeHolding,
  holding: Holding,
  events: readonly DividendEvent[],
  received: readonly PaymentPoint[],
  timeline: FxTimeline,
  today: string,
): HoldingSchedule {
  const horizon = addIsoDays(today, DAYS_PER_YEAR);
  const upcoming = events
    .filter((e) => e.exDate > today && e.exDate <= horizon)
    .map((e) => ({ date: e.payDate ?? e.exDate, weight: timeline.toBase(holding.quantity * e.amount, e.currency) }));
  const weights = sum(upcoming.map((u) => u.weight));
  const declared = upcoming.map((u) => ({ date: u.date, amount: (income.declared * u.weight) / Math.max(weights, Number.EPSILON) }));
  const latest = received.at(-1);
  if (!latest || income.estimated <= 0) return { declared, estimated: [] };
  const perYear = paymentsPerYear(received.map((p) => p.date));
  const missing = Math.max(0, perYear - upcoming.length);
  const dates = estimatedDates(latest.date, perYear, upcoming.map((u) => u.date), missing, today);
  return { declared, estimated: dates.map((date) => ({ date, amount: income.estimated / dates.length })) };
}

function futureMonths(schedules: readonly HoldingSchedule[], today: string): FutureMonth[] {
  const keys = monthKeys(today);
  const months = keys.map((month) => ({ month, declared: 0, estimated: 0 }));
  for (const s of schedules) {
    for (const p of s.declared) months[monthIndex(p.date, keys[0]!)]!.declared += p.amount;
    for (const p of s.estimated) months[monthIndex(p.date, keys[0]!)]!.estimated += p.amount;
  }
  return months.map((m) => ({ month: m.month, declared: roundTo(m.declared), estimated: roundTo(m.estimated) }));
}

/** Forward income per holding and month, same placement rules as `futureMonths`. */
function futureByHolding(rows: readonly Row[], today: string): FutureHoldingAmount[] {
  const keys = monthKeys(today);
  const entries: FutureHoldingAmount[] = [];
  for (const { holding, schedule } of rows) {
    const months = keys.map(() => ({ declared: 0, estimated: 0 }));
    for (const p of schedule.declared) months[monthIndex(p.date, keys[0]!)]!.declared += p.amount;
    for (const p of schedule.estimated) months[monthIndex(p.date, keys[0]!)]!.estimated += p.amount;
    months.forEach((m, i) => {
      const declared = roundTo(m.declared);
      const estimated = roundTo(m.estimated);
      if (declared > 0 || estimated > 0) entries.push({ month: keys[i]!, symbol: holding.symbol, declared, estimated });
    });
  }
  return [...entries].sort((a, b) => a.month.localeCompare(b.month) || a.symbol.localeCompare(b.symbol));
}

// --- Rows --------------------------------------------------------------------------------------------

function netReceived(transactions: readonly Transaction[], timeline: FxTimeline, since?: string): number {
  return sum(transactions.filter((t) => since === undefined || t.date > since).map((t) => transactionAmount(t, timeline)));
}

interface Row {
  holding: DividendOverviewHolding;
  schedule: HoldingSchedule;
}

function buildRow(
  h: Holding,
  income: PassiveIncomeHolding | undefined,
  dividends: readonly Transaction[],
  events: readonly DividendEvent[],
  timeline: FxTimeline,
  today: string,
): Row | null {
  const received = receivedPoints(dividends);
  const history = mergePaymentHistory(received, events, today);
  if (!income && history.length === 0) return null;
  const growth = dividendGrowthCagr(history);
  const since = addIsoDays(today, -DAYS_PER_YEAR);
  return {
    holding: {
      symbol: h.symbol,
      name: h.name,
      assetClass: h.assetClass,
      currency: h.currency,
      marketValue: h.marketValue,
      costBasis: h.costBasis,
      forward12m: income?.total ?? 0,
      declared: income?.declared ?? 0,
      estimated: income?.estimated ?? 0,
      sharePct: income?.sharePct ?? 0,
      yieldPct: income?.yieldPct ?? 0,
      yieldOnCostPct: income?.yieldOnCostPct ?? 0,
      received12m: roundTo(netReceived(dividends, timeline, since)),
      receivedTotal: roundTo(netReceived(dividends, timeline)),
      growthPct: growth.cagrPct,
      growthYears: growth.years,
      consistency: scoreConsistency(history, today),
    },
    schedule: income ? holdingSchedule(income, h, events, received, timeline, today) : { declared: [], estimated: [] },
  };
}

interface Trailing {
  last12m: number;
  previous12m: number;
  firstDividend: string | null;
  value: number;
  cost: number;
  payers: number;
}

const percentOf = (num: number, den: number) => (den > 0 ? ratioToPct(num / den) : 0);

function summaryOf(passive: PassiveIncome, t: Trailing, today: string): DividendOverviewSummary {
  const { last12m, previous12m } = t;
  return {
    forward12m: passive.forward12m,
    declared: passive.declared,
    estimated: passive.estimated,
    monthlyAverage: roundTo(passive.forward12m / MONTHS),
    yieldOnValuePct: passive.yieldOnValuePct,
    yieldOnCostPct: passive.yieldOnCostPct,
    last12m: roundTo(last12m),
    growthVsLast12mPct: last12m > 0 ? ratioToPct(passive.forward12m / last12m - 1) : null,
    previous12m: roundTo(previous12m),
    ttmGrowthPct: previous12m > 0 ? ratioToPct(last12m / previous12m - 1) : null,
    previous12mPartial: previous12m > 0 && t.firstDividend !== null && t.firstDividend > addIsoDays(today, -2 * DAYS_PER_YEAR),
    ttmYieldOnValuePct: percentOf(last12m, t.value),
    ttmYieldOnCostPct: percentOf(last12m, t.cost),
    ttmPayers: t.payers,
  };
}

/** Builds the `GET /dividends/overview` response for the (already scoped) data, like the API and the demo's mock backend do. */
export function computeDividendsOverview(data: AnalyticsData): DividendsOverviewResponse {
  const transactions = data.transactions.filter((t) => t.date <= data.today);
  const timeline = new FxTimeline(data.fx, data.fxHistory);
  const { holdings } = calculatePortfolio({
    transactions,
    quotes: data.quotes,
    profiles: data.profiles,
    fx: data.fx,
    fxHistory: data.fxHistory,
    now: data.now ?? new Date(`${data.today}T12:00:00Z`),
  });
  const passive = calculatePassiveIncome(holdings, transactions, data.dividendEvents, timeline, data.today);
  const incomeBySymbol = new Map(passive.holdings.map((i) => [i.symbol, i]));
  const dividendsBySymbol = groupBy(
    transactions.filter((t) => t.type === 'DIVIDEND'),
    (t) => t.symbol,
  );
  const eventsBySymbol: EventsBySymbol = groupBy(data.dividendEvents, (e) => e.symbol);

  const rows = holdings
    .map((h) => buildRow(h, incomeBySymbol.get(h.symbol), dividendsBySymbol.get(h.symbol) ?? [], eventsBySymbol.get(h.symbol) ?? [], timeline, data.today))
    .filter((r): r is Row => r !== null);
  const allDividends = [...dividendsBySymbol.values()].flat();
  const yearAgo = addIsoDays(data.today, -DAYS_PER_YEAR);
  const trailing: Trailing = {
    last12m: netReceived(allDividends, timeline, yearAgo),
    previous12m: netReceived(
      allDividends.filter((t) => t.date <= yearAgo),
      timeline,
      addIsoDays(data.today, -2 * DAYS_PER_YEAR),
    ),
    firstDividend: allDividends.reduce<string | null>((first, t) => (first === null || t.date < first ? t.date : first), null),
    value: holdings.reduce((s, h) => s + h.marketValue, 0),
    cost: holdings.reduce((s, h) => s + h.costBasis, 0),
    payers: [...dividendsBySymbol.values()].filter((list) => list.some((t) => t.date > yearAgo)).length,
  };

  return {
    baseCurrency: timeline.base,
    asOf: data.today,
    summary: summaryOf(passive, trailing, data.today),
    holdings: rows.map((r) => r.holding).sort((a, b) => b.forward12m - a.forward12m || a.symbol.localeCompare(b.symbol)),
    futureMonths: futureMonths(rows.map((r) => r.schedule), data.today),
    futureByHolding: futureByHolding(rows, data.today),
  };
}
