/**
 * The run rate of one held dividend payer: how often it pays and what a regular payment is, from the best evidence there is.
 * Pure. Forward income (Dividends page, Dashboard, Calendar, Goals) is built on it; see "Yield and income statistics" in docs/architecture.md.
 *
 * Evidence: the provider's stored dividend events of the symbol (declared and past, about two years), completed by the payments the owner
 * received (the same payment counts once, with the provider's amount); the owner's payments alone when the provider has nothing, and a single
 * known payment, which is flagged because one payment says nothing about the frequency.
 */
import { FxTimeline } from './fx.js';
import { addIsoDays, daysBetween, DAYS_PER_YEAR } from './analytics.js';
import type { DividendEvent, Transaction } from './types.js';

export const RUN_RATE_BASES = ['declared', 'provider-history', 'own-payments', 'single-payment-assumed', 'none'] as const;
/**
 * Where a holding's forward income rests: `declared` (every expected payment is announced), `provider-history` (frequency and amount from the
 * provider's dividend history), `own-payments` (from your own payments, no provider history), `single-payment-assumed` (only one payment is
 * known: assumed once a year, probably too low) or `none`.
 */
export type RunRateBasis = (typeof RUN_RATE_BASES)[number];

/** A payment of at least this many times the median of the (up to four) payments before it is a special dividend, not part of the run rate. */
export const SPECIAL_FACTOR = 1.8;
const SPECIAL_LOOKBACK = 4;
/** Payments needed before a larger one can be called special. */
const SPECIAL_MIN_HISTORY = 2;
/** Regular payments looked at for the frequency. */
const FREQUENCY_WINDOW = 5;
/** A payer whose latest regular payment is older than a year plus this grace (annual payers pay a little later some years) is treated as stopped. */
const STALE_GRACE_DAYS = 30;
/** Payments needed to infer a frequency. */
const MIN_PAYMENTS = 2;
/** A payment you received within this many days of an event's pay date is that event. */
const SAME_PAYMENT_DAYS = 7;
/** Without a pay date, a payment arriving up to this many days after the ex-date is the event's. */
const UNKNOWN_PAY_LAG_DAYS = 45;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Payments per year implied by the median gap between the last payments (1, 2, 4 or 12); 1 with fewer than two dates. */
export function paymentsPerYear(dates: readonly string[]): number {
  const recent = dates.slice(-FREQUENCY_WINDOW);
  if (recent.length < 2) return 1;
  const gaps = recent.slice(1).map((d, i) => daysBetween(recent[i]!, d)).sort((a, b) => a - b);
  const mid = gaps[Math.floor(gaps.length / 2)]!;
  if (mid <= 45) return 12;
  if (mid <= 135) return 4;
  return mid <= 270 ? 2 : 1;
}

/** Splits payments (oldest first) into regular ones and special dividends: one bigger than {@link SPECIAL_FACTOR} × the median of the payments before it. */
export function splitSpecial<T>(items: readonly T[], amountOf: (item: T) => number): { regular: T[]; special: T[] } {
  const regular: T[] = [];
  const special: T[] = [];
  const seen: number[] = [];
  for (const item of items) {
    const amount = amountOf(item);
    const before = seen.slice(-SPECIAL_LOOKBACK);
    (before.length >= SPECIAL_MIN_HISTORY && amount > SPECIAL_FACTOR * median(before) ? special : regular).push(item);
    seen.push(amount);
  }
  return { regular, special };
}

/** A payment that sets the pace: when it was paid, what per share (holding currency) and, for a provider event, its ex-date. */
interface Point {
  /** Pay date (the ex-date when the event has none; the day it arrived for a payment of yours). */
  date: string;
  amount: number;
  exDate?: string;
  payDate?: string;
}

export interface RunRate {
  basis: Exclude<RunRateBasis, 'declared'>;
  /** 1, 2, 4 or 12. */
  paymentsPerYear: number;
  /** The latest regular payment per share, in the holding's currency. */
  perShare: number;
  /** Pay date of the latest regular payment (the anchor of the projected schedule); null without evidence. */
  lastPayDate: string | null;
  /** Ex-dates of the provider's events that are special dividends: they are paid, but they are not one of the regular payments of the year. */
  specialExDates: ReadonlySet<string>;
}

const NO_SPECIAL: ReadonlySet<string> = new Set<string>();
export const NO_RUN_RATE: RunRate = { basis: 'none', paymentsPerYear: 1, perShare: 0, lastPayDate: null, specialExDates: NO_SPECIAL };

export interface OwnPayment {
  date: string;
  /** Gross dividend per share in the holding's currency, all payments of the day added up. */
  perShare: number;
}

export interface RunRateInput {
  /** Currency of the holding; every per-share amount comes out in it. */
  currency: string;
  /** Stored dividend events of the symbol (any order, any age). */
  events: readonly DividendEvent[];
  /** Payments the owner received for the symbol, oldest first. */
  payments: readonly OwnPayment[];
  timeline: FxTimeline;
  today: string;
}

function inHoldingCurrency(input: RunRateInput, amount: number, currency: string): number {
  if (currency === input.currency) return amount;
  return input.timeline.toBase(amount, currency) * input.timeline.rate(input.currency);
}

/** The provider's events up to a year ahead, one per ex-date, oldest first. */
function providerPoints(input: RunRateInput): Point[] {
  const horizon = addIsoDays(input.today, DAYS_PER_YEAR);
  const byExDate = new Map<string, DividendEvent>();
  for (const e of input.events) if (e.amount > 0 && e.exDate <= horizon) byExDate.set(e.exDate, e);
  return [...byExDate.values()].map((e) => ({ date: e.payDate ?? e.exDate, payDate: e.payDate, exDate: e.exDate, amount: inHoldingCurrency(input, e.amount, e.currency) }));
}

/** A payment you received within a few days of an event's pay date (or, without one, shortly after its ex-date) is that event. */
function isEventPayment(event: Point, date: string): boolean {
  const lastDay = addIsoDays(event.payDate ?? event.exDate!, event.payDate === undefined ? UNKNOWN_PAY_LAG_DAYS : SAME_PAYMENT_DAYS);
  return date >= addIsoDays(event.exDate!, -SAME_PAYMENT_DAYS) && date <= lastDay;
}

/** The provider's points plus the payments you received that are not one of them, oldest first. */
function evidence(input: RunRateInput): Point[] {
  const provider = providerPoints(input);
  const own = input.payments
    .filter((p) => p.perShare > 0 && !provider.some((q) => isEventPayment(q, p.date)))
    .map((p) => ({ date: p.date, amount: p.perShare }));
  return [...provider, ...own].sort((a, b) => a.date.localeCompare(b.date));
}

function rateOf(basis: RunRate['basis'], regular: readonly Point[], specialExDates: ReadonlySet<string>): RunRate {
  const latest = regular.at(-1)!;
  const perYear = regular.length >= MIN_PAYMENTS ? paymentsPerYear(regular.map((p) => p.date)) : 1;
  return { basis, paymentsPerYear: perYear, perShare: latest.amount, lastPayDate: latest.date, specialExDates };
}

/** Whether the latest regular payment is recent enough (or still ahead) for the payer to count as active. */
const isActive = (regular: readonly Point[], today: string): boolean => regular.at(-1)!.date > addIsoDays(today, -(DAYS_PER_YEAR + STALE_GRACE_DAYS));

/**
 * Frequency and regular amount of one holding, from the provider's dividend events (declared and past) completed by the payments you received
 * (the same payment is counted once, with the provider's amount). Special dividends are left out of both; a payer with no regular payment in the
 * last year (plus a month) has no run rate (`none`). With a single known payment the rate is that payment once a year, flagged
 * `single-payment-assumed`. The basis is `provider-history` when most of the payments the frequency rests on (the latest five) are the provider's, else `own-payments`.
 */
export function deriveRunRate(input: RunRateInput): RunRate {
  const { regular, special } = splitSpecial(evidence(input), (p) => p.amount);
  const specialExDates = new Set(special.flatMap((p) => (p.exDate === undefined ? [] : [p.exDate])));
  if (regular.length === 0 || !isActive(regular, input.today)) return { ...NO_RUN_RATE, specialExDates };
  if (regular.length < MIN_PAYMENTS) return rateOf('single-payment-assumed', regular, specialExDates);
  const recent = regular.slice(-FREQUENCY_WINDOW);
  const providerCount = recent.filter((p) => p.exDate !== undefined).length;
  return rateOf(providerCount * 2 > recent.length ? 'provider-history' : 'own-payments', regular, specialExDates);
}

// --- Withholding tax -----------------------------------------------------------------------------------------

/**
 * Share of a gross dividend that reaches you, observed on the dividends received in the trailing year: the symbol's own payments, else the
 * payments of every holding paid in the same currency (a US payer you just bought is withheld like the other US payers), else 1 (gross).
 * `trailing` holds the DIVIDEND transactions of the last 12 months.
 */
export function observedNetFactor(trailing: readonly Transaction[], symbol: string, currency: string): number {
  const ratio = (list: readonly Transaction[]): number | null => {
    const gross = list.reduce((s, t) => s + t.quantity * t.price, 0);
    return gross > 0 ? Math.max(0, 1 - list.reduce((s, t) => s + t.fee, 0) / gross) : null;
  };
  return ratio(trailing.filter((t) => t.symbol === symbol)) ?? ratio(trailing.filter((t) => t.currency === currency)) ?? 1;
}
