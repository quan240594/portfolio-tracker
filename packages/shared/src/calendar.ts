/**
 * Calendar: ex-dividend and pay dates, earnings reports, stock splits and other share adjustments of the user's
 * holdings (and optionally the watchlist). Everything here is pure: the API route and the MSW demo handlers load their
 * data and call `buildCalendar`, so the GitHub Pages demo shows the same numbers as a real deployment.
 *
 * DynamoDB items written by services/prices (`calendar_handlers.py`), next to the existing `DIV#` items:
 *
 * | Entity         | PK               | SK                | entityType       |
 * |----------------|------------------|-------------------|------------------|
 * | Earnings event | TICKER#{symbol}  | EARN#{date}       | EARNINGS_EVENT   |
 * | Split event    | TICKER#{symbol}  | SPLIT#{date}      | SPLIT_EVENT      |
 */
import { addIsoDays, daysBetween, DAYS_PER_YEAR, roundTo, transactionAmount } from './analytics.js';
import { calculatePassiveIncome, paymentsPerYear, type PassiveIncome } from './analytics-income.js';
import { FxTimeline } from './fx.js';
import { buildPositions, calculatePortfolio, type Position } from './portfolio.js';
import type { DividendEvent, FxDay, FxRates, InstrumentProfile, Quote, Transaction } from './types.js';

export const CALENDAR_EVENT_TYPES = ['EX_DIVIDEND', 'DIVIDEND_PAY', 'EARNINGS', 'SPLIT', 'CORPORATE_ACTION'] as const;
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

/** CONFIRMED = announced by a data provider (or recorded by you); ESTIMATED = a projection; PAID = a dividend you received. */
export const CALENDAR_STATUSES = ['CONFIRMED', 'ESTIMATED', 'PAID'] as const;
export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

export const CALENDAR_SCOPES = ['holdings', 'watchlist', 'all'] as const;
export type CalendarScope = (typeof CALENDAR_SCOPES)[number];

export const CALENDAR_EARNINGS_TIMES = ['BMO', 'AMC', 'unknown'] as const;
/** Before market open, after market close, or not reported by the data source. */
export type CalendarEarningsTime = (typeof CALENDAR_EARNINGS_TIMES)[number];

export type CalendarOrigin = 'HOLDING' | 'WATCHLIST';

/** Where an earnings date stands: `reported` (results released, from a stored summary), `scheduled` (a date from a data provider) or `projected` (the previous report plus about a quarter). */
export const CALENDAR_EARNINGS_PHASES = ['reported', 'scheduled', 'projected'] as const;
export type CalendarEarningsPhase = (typeof CALENDAR_EARNINGS_PHASES)[number];

export const CALENDAR_TYPE_LABELS: Readonly<Record<CalendarEventType, string>> = {
  EX_DIVIDEND: 'Ex-dividend',
  DIVIDEND_PAY: 'Dividend payment',
  EARNINGS: 'Earnings',
  SPLIT: 'Stock split',
  CORPORATE_ACTION: 'Corporate action',
};

/** Longest date range one request may ask for. */
export const MAX_CALENDAR_RANGE_DAYS = 400;
/** The income chart shows this many months, starting this many months before the current one. */
export const CALENDAR_CHART_MONTHS = 12;
export const CALENDAR_CHART_LOOKBACK_MONTHS = 3;

export const CALENDAR_COVERAGE = {
  earnings:
    'Upcoming earnings dates come from the free Alpha Vantage earnings calendar (one call a day for the next 12 months); European listings are matched to their US ticker where one exists. ' +
    'Reported results come from the earnings summaries and link to them. Where no date is announced, the next date is projected from the previous report (about 91 days later) and marked Estimated. ' +
    'Provider dates stay estimates until the day has passed.',
  corporateActions:
    'Stock splits and reverse splits (EODHD, refreshed on a rotating daily budget) and the splits you record yourself. ' +
    'Share adjustments that EODHD reports with an irregular ratio (stock dividends, spin-off adjustments) show as corporate actions. ' +
    'Mergers, spin-offs, symbol changes and rights issues are not available from free data sources.',
} as const;

// --- Stored items -----------------------------------------------------------------------------------

export const CALENDAR_ENTITY = { earnings: 'EARNINGS_EVENT', split: 'SPLIT_EVENT' } as const;

export const calendarKeys = {
  earnings: (symbol: string, date: string) => ({ PK: `TICKER#${symbol}`, SK: `EARN#${date}` }),
  earningsPrefix: 'EARN#',
  split: (symbol: string, date: string) => ({ PK: `TICKER#${symbol}`, SK: `SPLIT#${date}` }),
  splitPrefix: 'SPLIT#',
  tickerPk: (symbol: string) => `TICKER#${symbol}`,
} as const;

/** An announced earnings report/call of one company (`EARN#{date}`). */
export interface StoredEarningsEvent {
  symbol: string;
  date: string;
  name?: string;
  /** End of the fiscal quarter/year the report is about. */
  fiscalPeriodEnd?: string;
  epsEstimate?: number;
  /** Currency of `epsEstimate`. */
  currency?: string;
  timeOfDay?: CalendarEarningsTime;
  /** True when the source states the date is confirmed by the company (none of the free sources do). */
  confirmed?: boolean;
  source: string;
  updatedAt?: string;
}

/** A stock split (`SPLIT#{date}`): holders get `toFactor` new shares for every `fromFactor` old ones. */
export interface StoredSplitEvent {
  symbol: string;
  date: string;
  fromFactor: number;
  toFactor: number;
  source: string;
  updatedAt?: string;
}

/** What the API reads from the ticker partitions for a calendar request. */
export interface StoredCalendarEvents {
  earnings: StoredEarningsEvent[];
  splits: StoredSplitEvent[];
}

// --- Splits ------------------------------------------------------------------------------------------

export type CalendarSplitKind = 'SPLIT' | 'REVERSE_SPLIT' | 'ADJUSTMENT';

const MAX_PLAIN_FACTOR = 20;
const MAX_PLAIN_REVERSE_FACTOR = 100;

/**
 * Plain splits are whole-number ratios such as 4-for-1, 3-for-2 or 1-for-10; anything else (104-for-100, 1281-for-1000)
 * is how data providers record stock dividends, spin-off adjustments and reorganisations.
 */
export function calendarSplitKind(fromFactor: number, toFactor: number): CalendarSplitKind {
  const whole = Number.isInteger(fromFactor) && Number.isInteger(toFactor) && fromFactor > 0 && toFactor > 0;
  const big = Math.max(fromFactor, toFactor);
  const small = Math.min(fromFactor, toFactor);
  const plain = whole && (big <= MAX_PLAIN_FACTOR || (small === 1 && big <= MAX_PLAIN_REVERSE_FACTOR));
  if (!plain || fromFactor === toFactor) return 'ADJUSTMENT';
  return toFactor > fromFactor ? 'SPLIT' : 'REVERSE_SPLIT';
}

const formatFactor = (n: number): string => String(roundTo(n, 4));

export function calendarSplitLabel(fromFactor: number, toFactor: number): string {
  const ratio = `${formatFactor(toFactor)}-for-${formatFactor(fromFactor)}`;
  const kind = calendarSplitKind(fromFactor, toFactor);
  if (kind === 'SPLIT') return `${ratio} stock split`;
  if (kind === 'REVERSE_SPLIT') return `${ratio} reverse split`;
  return `Share adjustment ${ratio}`;
}

/** SPLIT transactions hold the new shares per old share (4 = 4:1, 0.1 = 1:10); returns the smallest whole-number ratio. */
export function calendarRatioFromQuantity(quantity: number): { fromFactor: number; toFactor: number } {
  for (let old = 1; old <= 10; old++) {
    const scaled = quantity * old;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return { fromFactor: old, toFactor: Math.round(scaled) };
  }
  return { fromFactor: 1, toFactor: quantity };
}

// --- Output ------------------------------------------------------------------------------------------

export interface CalendarEvent {
  /** Stable across requests (also the basis of the .ics UID). */
  id: string;
  date: string;
  type: CalendarEventType;
  symbol: string;
  name: string;
  status: CalendarStatus;
  /** HOLDING: the symbol is in your transactions; WATCHLIST: only on your watchlist. */
  origin: CalendarOrigin;
  /** Where the date comes from: `alphavantage`, `eodhd`, `market-data`, `transactions` or `estimate`. */
  source: string;
  description: string;
  /** Dividends: per-share amount in `currency`. */
  amountPerShare?: number;
  currency?: string;
  exDate?: string;
  payDate?: string;
  /** Shares held on the ex-date (HOLDING dividends only). */
  quantity?: number;
  /** Your expected (or, when PAID, received) net amount in the base currency. */
  expectedAmount?: number;
  /** True for the one event of a dividend whose amount counts towards the income totals (the pay date, else the ex-date). */
  countsAsIncome?: boolean;
  fiscalPeriodEnd?: string;
  epsEstimate?: number;
  timeOfDay?: CalendarEarningsTime;
  /** EARNINGS only. */
  earningsPhase?: CalendarEarningsPhase;
  /** Fiscal period of a reported release, as the company calls it ("Q3 2026"). */
  period?: string;
  splitFrom?: number;
  splitTo?: number;
}

export interface CalendarSummary {
  /** Net income expected over the next 12 months (declared + estimated), as on the analytics page. */
  annualIncome: number;
  monthlyAverage: number;
  dailyAverage: number;
  /** Forward income / market value, percent. */
  yieldPct: number;
  yieldOnCostPct: number;
  declared: number;
  estimated: number;
}

export interface CalendarMonth {
  month: string;
  paid: number;
  declared: number;
  estimated: number;
  total: number;
}

export interface CalendarResponse {
  baseCurrency: string;
  from: string;
  to: string;
  events: CalendarEvent[];
  summary: CalendarSummary;
  /** CALENDAR_CHART_MONTHS months of income by status; independent of the requested range and filters. */
  monthly: CalendarMonth[];
  coverage: { earnings: string; corporateActions: string };
}

export interface CalendarQuery {
  from: string;
  to: string;
  types?: readonly CalendarEventType[];
  statuses?: readonly CalendarStatus[];
  scope: CalendarScope;
}

/** A released quarterly result (one stored earnings summary): the report date and the fiscal period the company gave it. */
export interface ReportedEarnings {
  symbol: string;
  reportDate: string;
  period?: string;
}

export interface CalendarData {
  /** YYYY-MM-DD: the "current" day. */
  today: string;
  transactions: readonly Transaction[];
  quotes: Readonly<Record<string, Quote>>;
  profiles: Readonly<Record<string, InstrumentProfile>>;
  fx: FxRates;
  fxHistory?: readonly FxDay[];
  dividendEvents: readonly DividendEvent[];
  earnings: readonly StoredEarningsEvent[];
  /** Released results of the held companies; they show as reported earnings and anchor the projected next date. */
  reportedEarnings?: readonly ReportedEarnings[];
  splits: readonly StoredSplitEvent[];
  /** Symbols on the user's watchlist. */
  watchlist: readonly string[];
}

// --- Dates -------------------------------------------------------------------------------------------

export const calendarMonthOf = (date: string): string => date.slice(0, 7);

export function calendarAddMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export const calendarLastDay = (month: string): string => addIsoDays(`${calendarAddMonths(month, 1)}-01`, -1);

/** Current month ± 1 month. */
export function defaultCalendarRange(today: string): { from: string; to: string } {
  const month = calendarMonthOf(today);
  return { from: `${calendarAddMonths(month, -1)}-01`, to: calendarLastDay(calendarAddMonths(month, 1)) };
}

/** First and last day of the months shown by the income chart. */
export function calendarChartWindow(today: string): { from: string; to: string } {
  const first = calendarAddMonths(calendarMonthOf(today), -CALENDAR_CHART_LOOKBACK_MONTHS);
  return { from: `${first}-01`, to: calendarLastDay(calendarAddMonths(first, CALENDAR_CHART_MONTHS - 1)) };
}

/** The dates stored events must be loaded for: the requested range plus the income chart. */
export function calendarDataWindow(range: { from: string; to: string }, today: string): { from: string; to: string } {
  const chart = calendarChartWindow(today);
  return { from: range.from < chart.from ? range.from : chart.from, to: range.to > chart.to ? range.to : chart.to };
}

// --- Context -----------------------------------------------------------------------------------------

const EPSILON = 1e-9;
const TYPE_ORDER = new Map<CalendarEventType, number>(CALENDAR_EVENT_TYPES.map((t, i) => [t, i]));
/** A received dividend is matched with a declared one when the dates are at most this many days apart. */
const PAID_MATCH_DAYS = 7;
/** Without a pay date a payment is matched when it arrives within this many days after the ex-date. */
const PAID_MATCH_AFTER_EX_DAYS = 60;
const OWN_SPLIT_MATCH_DAYS = 3;

interface Ctx {
  today: string;
  timeline: FxTimeline;
  transactions: readonly Transaction[];
  currentPositions: ReadonlyMap<string, Position>;
  quantityOn: (symbol: string, date: string) => number;
  originOf: (symbol: string) => CalendarOrigin | null;
  nameOf: (symbol: string, fallback?: string) => string;
  netFactor: (symbol: string) => number;
}

function createContext(data: CalendarData): Ctx {
  const timeline = new FxTimeline(data.fx, data.fxHistory);
  const cache = new Map<string, ReadonlyMap<string, Position>>();
  const positionsAsOf = (date: string): ReadonlyMap<string, Position> => {
    let positions = cache.get(date);
    if (!positions) {
      positions = buildPositions(data.transactions, date);
      cache.set(date, positions);
    }
    return positions;
  };
  const tradedSymbols = new Set(data.transactions.map((t) => t.symbol));
  const watched = new Set(data.watchlist);
  const trailingStart = addIsoDays(data.today, -DAYS_PER_YEAR);
  const trailing = data.transactions.filter((t) => t.type === 'DIVIDEND' && t.date > trailingStart && t.date <= data.today);

  return {
    today: data.today,
    timeline,
    transactions: data.transactions,
    currentPositions: positionsAsOf(data.today),
    // Shares bought on the ex-date are not entitled; a future ex-date assumes the current position.
    quantityOn: (symbol, date) => positionsAsOf(date > data.today ? data.today : addIsoDays(date, -1)).get(symbol)?.quantity ?? 0,
    originOf: (symbol) => {
      if (tradedSymbols.has(symbol)) return 'HOLDING';
      return watched.has(symbol) ? 'WATCHLIST' : null;
    },
    nameOf: (symbol, fallback) => data.profiles[symbol]?.name ?? fallback ?? symbol,
    // Same observed-withholding rule as calculatePassiveIncome, so event amounts add up to the analytics figures.
    netFactor: (symbol) => {
      const own = trailing.filter((t) => t.symbol === symbol);
      const gross = own.reduce((s, t) => s + t.quantity * t.price, 0);
      return gross > 0 ? Math.max(0, 1 - own.reduce((s, t) => s + t.fee, 0) / gross) : 1;
    },
  };
}

// --- Dividends ---------------------------------------------------------------------------------------

const isPositive = (n: number | undefined): n is number => n !== undefined && n > EPSILON;

function describeDividend(amountPerShare: number, currency: string, quantity: number | undefined): string {
  const perShare = `${roundTo(amountPerShare, 4)} ${currency} per share`;
  return quantity === undefined ? perShare : `${perShare} × ${roundTo(quantity, 8)} shares`;
}

/** Declared payment of `ev` for `quantity` shares: net, in the base currency (latest FX for the future, ex-date FX for the past). */
function declaredAmount(ctx: Ctx, ev: DividendEvent, quantity: number): number {
  const rateDate = ev.exDate > ctx.today ? undefined : ev.exDate;
  return ctx.timeline.toBase(quantity * ev.amount, ev.currency, rateDate) * ctx.netFactor(ev.symbol);
}

function dedupeDividends(events: readonly DividendEvent[]): DividendEvent[] {
  const byKey = new Map<string, DividendEvent>();
  for (const e of events) byKey.set(`${e.symbol}|${e.exDate}`, e);
  return [...byKey.values()];
}

/** The not yet matched received payment that belongs to a declared dividend, closest in time. */
function findPayment(unmatched: ReadonlyMap<string, Transaction>, ev: DividendEvent): Transaction | undefined {
  const anchor = ev.payDate ?? ev.exDate;
  let best: Transaction | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const t of unmatched.values()) {
    if (t.symbol !== ev.symbol) continue;
    const gap = Math.abs(daysBetween(anchor, t.date));
    const sinceEx = daysBetween(ev.exDate, t.date);
    const within = ev.payDate ? gap <= PAID_MATCH_DAYS : sinceEx >= 0 && sinceEx <= PAID_MATCH_AFTER_EX_DAYS;
    if (within && gap < bestGap) {
      best = t;
      bestGap = gap;
    }
  }
  return best;
}

interface DividendBase {
  symbol: string;
  name: string;
  origin: CalendarOrigin;
}

function exEvent(base: DividendBase, ev: DividendEvent, quantity: number | undefined, expected: number | undefined, counts: boolean): CalendarEvent {
  return {
    ...base,
    id: `ex:${ev.symbol}:${ev.exDate}`,
    date: ev.exDate,
    type: 'EX_DIVIDEND',
    status: 'CONFIRMED',
    source: 'market-data',
    description: describeDividend(ev.amount, ev.currency, quantity),
    amountPerShare: ev.amount,
    currency: ev.currency,
    exDate: ev.exDate,
    payDate: ev.payDate,
    quantity,
    expectedAmount: expected === undefined ? undefined : roundTo(expected),
    countsAsIncome: counts,
  };
}

function payEvent(ctx: Ctx, base: DividendBase, ev: DividendEvent, quantity: number | undefined, expected: number | undefined, paid: Transaction | undefined): CalendarEvent {
  const received = paid ? roundTo(transactionAmount(paid, ctx.timeline)) : undefined;
  const amount = paid ? paid.price : ev.amount;
  const currency = paid ? paid.currency : ev.currency;
  const shares = paid ? paid.quantity : quantity;
  return {
    ...base,
    id: `pay:${ev.symbol}:${ev.exDate}`,
    date: paid?.date ?? ev.payDate ?? ev.exDate,
    type: 'DIVIDEND_PAY',
    status: paid ? 'PAID' : 'CONFIRMED',
    source: paid ? 'transactions' : 'market-data',
    description: describeDividend(amount, currency, shares),
    amountPerShare: amount,
    currency,
    exDate: ev.exDate,
    payDate: paid?.date ?? ev.payDate,
    quantity: shares,
    expectedAmount: received ?? (expected === undefined ? undefined : roundTo(expected)),
    countsAsIncome: true,
  };
}

function declaredEntries(ctx: Ctx, ev: DividendEvent, base: DividendBase, quantity: number | undefined, paid: Transaction | undefined): CalendarEvent[] {
  const expected = quantity === undefined ? undefined : declaredAmount(ctx, ev, quantity);
  const hasPayEvent = ev.payDate !== undefined || paid !== undefined;
  const out = [exEvent(base, ev, quantity, expected, !hasPayEvent)];
  if (hasPayEvent) out.push(payEvent(ctx, base, ev, quantity, expected, paid));
  return out;
}

/** A dividend that is in your transactions but matches no declared event. */
function paidEntry(ctx: Ctx, t: Transaction): CalendarEvent {
  return {
    id: `paid:${t.id}`,
    date: t.date,
    type: 'DIVIDEND_PAY',
    status: 'PAID',
    symbol: t.symbol,
    name: ctx.nameOf(t.symbol),
    origin: 'HOLDING',
    source: 'transactions',
    description: describeDividend(t.price, t.currency, t.quantity),
    amountPerShare: t.price,
    currency: t.currency,
    payDate: t.date,
    quantity: t.quantity,
    expectedAmount: roundTo(transactionAmount(t, ctx.timeline)),
    countsAsIncome: true,
  };
}

function dividendEntries(ctx: Ctx, stored: readonly DividendEvent[]): CalendarEvent[] {
  const unmatched = new Map(ctx.transactions.filter((t) => t.type === 'DIVIDEND').map((t): [string, Transaction] => [t.id, t]));
  const out: CalendarEvent[] = [];
  for (const ev of dedupeDividends(stored)) {
    const origin = ctx.originOf(ev.symbol);
    if (!origin) continue;
    const quantity = origin === 'HOLDING' ? ctx.quantityOn(ev.symbol, ev.exDate) : undefined;
    if (origin === 'HOLDING' && !isPositive(quantity)) continue;
    const paid = origin === 'HOLDING' ? findPayment(unmatched, ev) : undefined;
    if (paid) unmatched.delete(paid.id);
    out.push(...declaredEntries(ctx, ev, { symbol: ev.symbol, name: ctx.nameOf(ev.symbol), origin }, quantity, paid));
  }
  for (const t of unmatched.values()) out.push(paidEntry(ctx, t));
  return out;
}

// --- Estimated dividends -----------------------------------------------------------------------------

interface PaymentDay {
  date: string;
  perShare: number;
}

function paymentDaysOf(transactions: readonly Transaction[], symbol: string): PaymentDay[] {
  const byDate = new Map<string, number>();
  for (const t of transactions) {
    if (t.type === 'DIVIDEND' && t.symbol === symbol) byDate.set(t.date, (byDate.get(t.date) ?? 0) + t.price);
  }
  return [...byDate.entries()].map(([date, perShare]) => ({ date, perShare })).sort((a, b) => a.date.localeCompare(b.date));
}

/** Median days between the ex-date and the pay date of the stored events (undefined without any). */
function medianPayLag(declared: readonly DividendEvent[]): number | undefined {
  const lags = declared
    .filter((e) => e.payDate)
    .map((e) => daysBetween(e.exDate, e.payDate!))
    .sort((a, b) => a - b);
  return lags.length > 0 ? lags[Math.floor(lags.length / 2)] : undefined;
}

/** Pay dates of the payments the history implies that no declared event covers yet, nearest first. */
function projectedPayDates(ctx: Ctx, days: readonly PaymentDay[], declared: readonly DividendEvent[]): string[] {
  const last = days.at(-1)!;
  const horizon = addIsoDays(ctx.today, DAYS_PER_YEAR);
  const perYear = paymentsPerYear(days.map((d) => d.date));
  const upcoming = declared.filter((e) => e.exDate > ctx.today && e.exDate <= horizon);
  const missing = Math.max(0, perYear - upcoming.length);
  const interval = Math.round(DAYS_PER_YEAR / perYear);
  const covered = (date: string) => declared.some((e) => Math.abs(daysBetween(date, e.payDate ?? e.exDate)) < interval / 2);
  const first = Math.max(1, Math.floor(daysBetween(last.date, ctx.today) / interval) + 1);
  const out: string[] = [];
  for (let k = first; k <= first + 2 * perYear + 2 && out.length < missing; k++) {
    const date = addIsoDays(last.date, k * interval);
    if (date > horizon) break;
    if (!covered(date)) out.push(date);
  }
  return out;
}

function estimatedEntries(ctx: Ctx, symbol: string, position: Position, declared: readonly DividendEvent[]): CalendarEvent[] {
  const days = paymentDaysOf(ctx.transactions, symbol);
  const last = days.at(-1);
  const trailingStart = addIsoDays(ctx.today, -DAYS_PER_YEAR);
  // Like the analytics forecast: only payers that paid within the last year are projected.
  if (!last || !days.some((d) => d.date > trailingStart && d.date <= ctx.today)) return [];
  const expected = roundTo(ctx.timeline.toBase(position.quantity * last.perShare, position.currency) * ctx.netFactor(symbol));
  const lag = medianPayLag(declared);
  const base: DividendBase = { symbol, name: ctx.nameOf(symbol), origin: 'HOLDING' };
  const shared = { ...base, status: 'ESTIMATED' as const, source: 'estimate', amountPerShare: last.perShare, currency: position.currency, quantity: position.quantity };
  const out: CalendarEvent[] = [];
  for (const payDate of projectedPayDates(ctx, days, declared)) {
    const description = `${describeDividend(last.perShare, position.currency, position.quantity)} (projected from your payment history)`;
    out.push({ ...shared, id: `est-pay:${symbol}:${payDate}`, date: payDate, type: 'DIVIDEND_PAY', description, payDate, expectedAmount: expected, countsAsIncome: true });
    if (lag !== undefined) {
      const exDate = addIsoDays(payDate, -lag);
      out.push({ ...shared, id: `est-ex:${symbol}:${exDate}`, date: exDate, type: 'EX_DIVIDEND', description, exDate, payDate, expectedAmount: expected, countsAsIncome: false });
    }
  }
  return out;
}

function estimatedDividends(ctx: Ctx, stored: readonly DividendEvent[]): CalendarEvent[] {
  const bySymbol = new Map<string, DividendEvent[]>();
  for (const e of stored) bySymbol.set(e.symbol, [...(bySymbol.get(e.symbol) ?? []), e]);
  const out: CalendarEvent[] = [];
  for (const [symbol, position] of ctx.currentPositions) {
    if (position.quantity > EPSILON) out.push(...estimatedEntries(ctx, symbol, position, bySymbol.get(symbol) ?? []));
  }
  return out;
}

// --- Earnings, splits --------------------------------------------------------------------------------

function describeEarnings(e: StoredEarningsEvent): string {
  const parts = ['Earnings report'];
  if (e.fiscalPeriodEnd) parts.push(`for the period ending ${e.fiscalPeriodEnd}`);
  if (e.epsEstimate !== undefined) parts.push(['· EPS estimate', e.epsEstimate, e.currency].filter((p) => p !== undefined).join(' '));
  if (e.timeOfDay === 'BMO') parts.push('· before market open');
  if (e.timeOfDay === 'AMC') parts.push('· after market close');
  return parts.join(' ');
}

/** Quarters are about 91 days apart; a stored report date plus this is where the next one is projected. */
export const EARNINGS_PROJECTION_DAYS = 91;
/** A provider date this close to a released report is that report (companies report a few days off the expected date). */
const REPORT_MATCH_DAYS = 4;
/** A projected date that has just passed is an overdue release, not a reason to project a whole quarter further. */
const OVERDUE_GRACE_DAYS = 14;
const MAX_PROJECTED_QUARTERS = 4;

function providerEarnings(ctx: Ctx, e: StoredEarningsEvent, origin: CalendarOrigin): CalendarEvent {
  return {
    id: `earn:${e.symbol}:${e.date}`,
    date: e.date,
    type: 'EARNINGS',
    status: e.confirmed || e.date <= ctx.today ? 'CONFIRMED' : 'ESTIMATED',
    symbol: e.symbol,
    name: ctx.nameOf(e.symbol, e.name),
    origin,
    source: e.source,
    description: describeEarnings(e),
    fiscalPeriodEnd: e.fiscalPeriodEnd,
    epsEstimate: e.epsEstimate,
    currency: e.currency,
    timeOfDay: e.timeOfDay ?? 'unknown',
    earningsPhase: 'scheduled',
  };
}

/** Released results: CONFIRMED (the date has passed; there is no separate "reported" status), labelled "Reported" in the text. */
function reportedEarnings(ctx: Ctx, report: ReportedEarnings, origin: CalendarOrigin, provider: StoredEarningsEvent | undefined): CalendarEvent {
  const period = report.period?.trim() || undefined;
  return {
    id: `earn:${report.symbol}:${report.reportDate}`,
    date: report.reportDate,
    type: 'EARNINGS',
    status: 'CONFIRMED',
    symbol: report.symbol,
    name: ctx.nameOf(report.symbol, provider?.name),
    origin,
    source: 'earnings-summary',
    description: period === undefined ? 'Reported results' : `Reported results for ${period}`,
    period,
    fiscalPeriodEnd: provider?.fiscalPeriodEnd,
    epsEstimate: provider?.epsEstimate,
    currency: provider?.currency,
    timeOfDay: provider?.timeOfDay ?? 'unknown',
    earningsPhase: 'reported',
  };
}

/** The date the next report is projected to fall on: the previous report plus whole quarters, never before today. */
export function projectedEarningsDate(lastReport: string, today: string): string | null {
  let date = lastReport;
  for (let quarter = 1; quarter <= MAX_PROJECTED_QUARTERS; quarter++) {
    date = addIsoDays(date, EARNINGS_PROJECTION_DAYS);
    if (date >= today) return date;
    if (daysBetween(date, today) <= OVERDUE_GRACE_DAYS) return null;
  }
  return null;
}

function projectedEarnings(ctx: Ctx, symbol: string, lastReport: ReportedEarnings, origin: CalendarOrigin): CalendarEvent | null {
  const date = projectedEarningsDate(lastReport.reportDate, ctx.today);
  if (date === null) return null;
  return {
    id: `earn-est:${symbol}:${date}`,
    date,
    type: 'EARNINGS',
    status: 'ESTIMATED',
    symbol,
    name: ctx.nameOf(symbol),
    origin,
    source: 'estimate',
    description: `Estimated next report, about ${EARNINGS_PROJECTION_DAYS} days after the previous one (${lastReport.reportDate}). A projection, not an announced date.`,
    timeOfDay: 'unknown',
    earningsPhase: 'projected',
  };
}

/**
 * Earnings of every symbol the user holds or watches: the provider's dates, the released reports (which replace the provider date
 * they match), and, for a company with a released report but no provider date still ahead, one projected next date.
 */
function earningsEntries(ctx: Ctx, stored: readonly StoredEarningsEvent[], reports: readonly ReportedEarnings[]): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const latest = new Map<string, ReportedEarnings>();
  for (const report of reports) {
    if (report.reportDate > (latest.get(report.symbol)?.reportDate ?? '')) latest.set(report.symbol, report);
  }
  const matched = new Set<StoredEarningsEvent>();
  for (const report of reports) {
    const origin = ctx.originOf(report.symbol);
    if (!origin) continue;
    const provider = stored.find((e) => e.symbol === report.symbol && Math.abs(daysBetween(e.date, report.reportDate)) <= REPORT_MATCH_DAYS);
    if (provider) matched.add(provider);
    out.push(reportedEarnings(ctx, report, origin, provider));
  }
  const ahead = new Set<string>();
  for (const e of stored) {
    const origin = ctx.originOf(e.symbol);
    if (!origin || matched.has(e)) continue;
    if (e.date >= ctx.today) ahead.add(e.symbol);
    out.push(providerEarnings(ctx, e, origin));
  }
  for (const [symbol, report] of latest) {
    const origin = ctx.originOf(symbol);
    const projection = origin && !ahead.has(symbol) ? projectedEarnings(ctx, symbol, report, origin) : null;
    if (projection) out.push(projection);
  }
  return out;
}

interface SplitSource {
  symbol: string;
  date: string;
  fromFactor: number;
  toFactor: number;
  source: string;
}

function splitEntry(ctx: Ctx, s: SplitSource, origin: CalendarOrigin): CalendarEvent {
  const kind = calendarSplitKind(s.fromFactor, s.toFactor);
  return {
    id: `split:${s.symbol}:${s.date}`,
    date: s.date,
    type: kind === 'ADJUSTMENT' ? 'CORPORATE_ACTION' : 'SPLIT',
    status: 'CONFIRMED',
    symbol: s.symbol,
    name: ctx.nameOf(s.symbol),
    origin,
    source: s.source,
    description: calendarSplitLabel(s.fromFactor, s.toFactor),
    splitFrom: s.fromFactor,
    splitTo: s.toFactor,
  };
}

/** The user's own SPLIT transactions; the same split entered in several portfolios counts once. */
function ownSplits(ctx: Ctx): SplitSource[] {
  const unique = new Map<string, SplitSource>();
  for (const t of ctx.transactions) {
    if (t.type !== 'SPLIT') continue;
    const ratio = calendarRatioFromQuantity(t.quantity);
    unique.set(`${t.symbol}|${t.date}|${ratio.fromFactor}|${ratio.toFactor}`, { symbol: t.symbol, date: t.date, source: 'transactions', ...ratio });
  }
  return [...unique.values()];
}

function splitEntries(ctx: Ctx, stored: readonly StoredSplitEvent[]): CalendarEvent[] {
  const own = ownSplits(ctx);
  const duplicatesOwn = (s: StoredSplitEvent) =>
    own.some((o) => o.symbol === s.symbol && Math.abs(daysBetween(o.date, s.date)) <= OWN_SPLIT_MATCH_DAYS);
  const providerSplits = stored.filter((s) => !duplicatesOwn(s));
  const out: CalendarEvent[] = [];
  for (const s of [...own, ...providerSplits]) {
    const origin = ctx.originOf(s.symbol);
    if (origin) out.push(splitEntry(ctx, s, origin));
  }
  return out;
}

// --- Assembly ----------------------------------------------------------------------------------------

function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  return (
    a.date.localeCompare(b.date) ||
    (TYPE_ORDER.get(a.type) ?? 0) - (TYPE_ORDER.get(b.type) ?? 0) ||
    a.symbol.localeCompare(b.symbol) ||
    a.id.localeCompare(b.id)
  );
}

const SCOPE_ORIGIN: Record<CalendarScope, CalendarOrigin | null> = { holdings: 'HOLDING', watchlist: 'WATCHLIST', all: null };

export type CalendarFilter = Pick<CalendarQuery, 'types' | 'statuses' | 'scope'>;

/** Event types, statuses and scope of a query (an empty list means "all"); the date range is not looked at. */
export function matchesCalendarFilter(e: CalendarEvent, q: CalendarFilter): boolean {
  if (q.types && q.types.length > 0 && !q.types.includes(e.type)) return false;
  if (q.statuses && q.statuses.length > 0 && !q.statuses.includes(e.status)) return false;
  const origin = SCOPE_ORIGIN[q.scope];
  return origin === null || e.origin === origin;
}

const matchesQuery = (e: CalendarEvent, q: CalendarQuery): boolean => e.date >= q.from && e.date <= q.to && matchesCalendarFilter(e, q);

/** Income per month (paid / declared / estimated) over the chart window, from the events that count as income. */
export function calendarMonthlyIncome(events: readonly CalendarEvent[], today: string): CalendarMonth[] {
  const first = calendarMonthOf(calendarChartWindow(today).from);
  const rows = Array.from({ length: CALENDAR_CHART_MONTHS }, (_, i) => ({ month: calendarAddMonths(first, i), paid: 0, declared: 0, estimated: 0, total: 0 }));
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  for (const e of events) {
    const row = byMonth.get(calendarMonthOf(e.date));
    if (!row || !e.countsAsIncome || e.expectedAmount === undefined) continue;
    if (e.status === 'PAID') row.paid += e.expectedAmount;
    else if (e.status === 'ESTIMATED') row.estimated += e.expectedAmount;
    else row.declared += e.expectedAmount;
  }
  return rows.map((r) => ({ month: r.month, paid: roundTo(r.paid), declared: roundTo(r.declared), estimated: roundTo(r.estimated), total: roundTo(r.paid + r.declared + r.estimated) }));
}

export function summarizeCalendarIncome(income: PassiveIncome): CalendarSummary {
  return {
    annualIncome: income.forward12m,
    monthlyAverage: roundTo(income.forward12m / CALENDAR_CHART_MONTHS),
    dailyAverage: roundTo(income.forward12m / DAYS_PER_YEAR),
    yieldPct: income.yieldOnValuePct,
    yieldOnCostPct: income.yieldOnCostPct,
    declared: income.declared,
    estimated: income.estimated,
  };
}

/**
 * Merges the stored events with the user's positions: dividends (ex-date and pay date, with the quantity held on the
 * ex-date and the expected net amount in the base currency), projected dividends, received dividends, earnings, splits
 * and the user's own SPLIT transactions. Summary and monthly totals describe the next 12 months of income and ignore
 * the filters; `events` honours the date range, types, statuses and scope.
 */
export function buildCalendar(data: CalendarData, query: CalendarQuery): CalendarResponse {
  const ctx = createContext(data);
  const portfolio = calculatePortfolio({
    transactions: data.transactions,
    quotes: data.quotes,
    profiles: data.profiles,
    fx: data.fx,
    fxHistory: data.fxHistory,
    now: new Date(`${data.today}T12:00:00Z`),
  });
  const income = calculatePassiveIncome(portfolio.holdings, data.transactions, data.dividendEvents, ctx.timeline, data.today);
  const all = [
    ...dividendEntries(ctx, data.dividendEvents),
    ...estimatedDividends(ctx, data.dividendEvents),
    ...earningsEntries(ctx, data.earnings, data.reportedEarnings ?? []),
    ...splitEntries(ctx, data.splits),
  ];
  return {
    baseCurrency: ctx.timeline.base,
    from: query.from,
    to: query.to,
    events: all.filter((e) => matchesQuery(e, query)).sort(compareEvents),
    summary: summarizeCalendarIncome(income),
    monthly: calendarMonthlyIncome(all, data.today),
    coverage: { ...CALENDAR_COVERAGE },
  };
}
