/**
 * Which dividend notifications are due. Pure: the notification job loads the user's transactions, the stored dividend events, the
 * names, the FX rates and the ledger of what was already sent, and this decides what to send. A stored dividend event is a
 * confirmed (declared) one: the calendar's estimates are projections and never notified, so "an estimate became confirmed" is simply
 * "a stored event with a ledger-less ex-date appeared".
 *
 * - `exDividend`: a held symbol whose ex-date is in (today, today + daysBefore], once per ex-date.
 * - `declared`: a stored event of a held symbol whose ex-date or pay date is today or later, once per ex-date.
 * - `received`: a DIVIDEND transaction, once per transaction id; one older than 14 days is recorded silently (a back-dated import).
 * - `earnings`: a stored earnings summary of a held symbol, once per report date; backfilled and stale ones are recorded silently.
 */
import { addIsoDays, daysBetween } from './analytics.js';
import { EARNINGS_FRESH_DAYS, type EarningsSummary } from './earnings.js';
import { buildEarningsNotification } from './earnings-format.js';
import { dividendComparison, type PerSharePayment } from './dividend-comparison.js';
import { FxTimeline } from './fx.js';
import {
  buildDeclaredNotification,
  buildExDividendNotification,
  buildReceivedNotification,
  type DividendNotice,
  type NotificationMessage,
} from './notification-messages.js';
import { RECEIVED_FRESH_DAYS, type NotificationSettings, type NotificationType } from './notifications.js';
import { buildPositions } from './portfolio.js';
import type { DividendEvent, FxRates, Transaction } from './types.js';

/** The identity of a ledger entry inside a set of notified entries. */
export const ledgerId = (type: NotificationType, symbol: string, eventKey: string): string => `${type}#${symbol}#${eventKey}`;

export interface LedgerRef {
  type: NotificationType;
  symbol: string;
  eventKey: string;
}

export interface DueNotification extends LedgerRef {
  id: string;
  message: NotificationMessage;
  /** Orders the notifications: the date they are about, then the symbol. */
  sortKey: string;
}

export interface DetectInput {
  /** The current day in the user's time zone (`YYYY-MM-DD`). */
  today: string;
  settings: NotificationSettings;
  baseCurrency: string;
  transactions: readonly Transaction[];
  /** Stored dividend events of (at least) the held symbols. */
  dividendEvents: readonly DividendEvent[];
  names: Readonly<Record<string, string | undefined>>;
  fx: FxRates | null;
  /** `ledgerId`s that were already notified. */
  notified: ReadonlySet<string>;
  /** The newest stored earnings summaries of (at least) the held symbols. */
  earnings?: readonly EarningsSummary[];
}

export interface Detection {
  due: DueNotification[];
  /** Entries to record without a push (back-dated payments). */
  silent: LedgerRef[];
}

const EPSILON = 1e-9;

interface Context {
  input: DetectInput;
  held: ReadonlyMap<string, number>;
  eventsBySymbol: ReadonlyMap<string, DividendEvent[]>;
  timeline: FxTimeline | undefined;
}

/** Shares held on `today` per symbol (positions above zero). Throws when the transactions cannot be replayed (an oversold position). */
export function heldQuantities(transactions: readonly Transaction[], today: string): Map<string, number> {
  const held = new Map<string, number>();
  for (const [symbol, position] of buildPositions(transactions, today)) if (position.quantity > EPSILON) held.set(symbol, position.quantity);
  return held;
}

/** One event per symbol and ex-date (the last stored wins), oldest first. */
function groupEvents(events: readonly DividendEvent[]): Map<string, DividendEvent[]> {
  const byKey = new Map<string, DividendEvent>();
  for (const event of events) if (event.amount > 0) byKey.set(`${event.symbol}|${event.exDate}`, event);
  const bySymbol = new Map<string, DividendEvent[]>();
  for (const event of [...byKey.values()].sort((a, b) => a.exDate.localeCompare(b.exDate))) {
    const list = bySymbol.get(event.symbol);
    if (list) list.push(event);
    else bySymbol.set(event.symbol, [event]);
  }
  return bySymbol;
}

function createContext(input: DetectInput): Context {
  const { fx } = input;
  return {
    input,
    held: heldQuantities(input.transactions, input.today),
    eventsBySymbol: groupEvents(input.dividendEvents),
    timeline: fx?.base === input.baseCurrency ? new FxTimeline(fx) : undefined,
  };
}

/** Amount in the base currency, or undefined when the currency cannot be converted. */
function toBase(ctx: Context, amount: number, currency: string): number | undefined {
  if (currency === ctx.input.baseCurrency) return amount;
  try {
    return ctx.timeline?.toBase(amount, currency);
  } catch {
    return undefined;
  }
}

/** Share of a payment that reaches you: 1 minus the withholding observed on the symbol's payments of the last 12 months (as the calendar does). */
function netFactor(ctx: Context, symbol: string): number {
  const since = addIsoDays(ctx.input.today, -365);
  const own = ctx.input.transactions.filter((t) => t.type === 'DIVIDEND' && t.symbol === symbol && t.date > since && t.date <= ctx.input.today);
  const gross = own.reduce((sum, t) => sum + t.quantity * t.price, 0);
  return gross > 0 ? Math.max(0, 1 - own.reduce((sum, t) => sum + t.fee, 0) / gross) : 1;
}

const eventHistory = (events: readonly DividendEvent[]): PerSharePayment[] => events.map((e) => ({ date: e.exDate, perShare: e.amount, currency: e.currency }));

function noticeFor(ctx: Context, event: DividendEvent): DividendNotice {
  const quantity = ctx.held.get(event.symbol);
  const gross = quantity === undefined ? undefined : toBase(ctx, quantity * event.amount, event.currency);
  const history = eventHistory(ctx.eventsBySymbol.get(event.symbol) ?? []);
  return {
    symbol: event.symbol,
    name: ctx.input.names[event.symbol],
    amountPerShare: event.amount,
    currency: event.currency,
    exDate: event.exDate,
    ...(event.payDate ? { payDate: event.payDate } : {}),
    comparison: dividendComparison(history, { date: event.exDate, perShare: event.amount, currency: event.currency }),
    baseCurrency: ctx.input.baseCurrency,
    ...(quantity === undefined || gross === undefined ? {} : { quantity, expectedAmount: gross * netFactor(ctx, event.symbol) }),
  };
}

const isUpcoming = (event: DividendEvent, today: string): boolean => event.exDate >= today || (event.payDate !== undefined && event.payDate >= today);

function dueOf(type: NotificationType, symbol: string, eventKey: string, sortKey: string, message: NotificationMessage): DueNotification {
  return { type, symbol, eventKey, id: ledgerId(type, symbol, eventKey), message, sortKey };
}

function exDividendDue(ctx: Context): DueNotification[] {
  const { today, settings, notified } = ctx.input;
  const due: DueNotification[] = [];
  for (const [symbol, events] of ctx.eventsBySymbol) {
    if (!ctx.held.has(symbol)) continue;
    for (const event of events) {
      const daysUntil = daysBetween(today, event.exDate);
      if (daysUntil < 1 || daysUntil > settings.exDividendDaysBefore || notified.has(ledgerId('exDividend', symbol, event.exDate))) continue;
      due.push(dueOf('exDividend', symbol, event.exDate, event.exDate, buildExDividendNotification(noticeFor(ctx, event), daysUntil)));
    }
  }
  return due;
}

function declaredDue(ctx: Context): DueNotification[] {
  const { today, notified } = ctx.input;
  const due: DueNotification[] = [];
  for (const [symbol, events] of ctx.eventsBySymbol) {
    if (!ctx.held.has(symbol)) continue;
    for (const event of events) {
      if (!isUpcoming(event, today) || notified.has(ledgerId('declared', symbol, event.exDate))) continue;
      due.push(dueOf('declared', symbol, event.exDate, event.exDate, buildDeclaredNotification(noticeFor(ctx, event))));
    }
  }
  return due;
}

/** Per-share payments the user received, one per date, as the history a received dividend is compared with. */
function receivedHistory(transactions: readonly Transaction[], symbol: string): PerSharePayment[] {
  const byDate = new Map<string, PerSharePayment>();
  for (const t of transactions) if (t.type === 'DIVIDEND' && t.symbol === symbol && t.price > 0 && !byDate.has(t.date)) byDate.set(t.date, { date: t.date, perShare: t.price, currency: t.currency });
  return [...byDate.values()];
}

/** Net amount of a payment in the base currency (the broker's rate when booked, else the latest), or in its own currency. */
function receivedAmount(ctx: Context, t: Transaction): { amount: number; currency: string } {
  const net = t.quantity * t.price - t.fee;
  if (t.currency === ctx.input.baseCurrency) return { amount: net, currency: t.currency };
  if (t.fxRate !== undefined && t.fxRate > 0) return { amount: net / t.fxRate, currency: ctx.input.baseCurrency };
  const converted = toBase(ctx, net, t.currency);
  return converted === undefined ? { amount: net, currency: t.currency } : { amount: converted, currency: ctx.input.baseCurrency };
}

function receivedMessage(ctx: Context, t: Transaction): NotificationMessage {
  const received = receivedAmount(ctx, t);
  const history = receivedHistory(ctx.input.transactions, t.symbol);
  return buildReceivedNotification({
    symbol: t.symbol,
    name: ctx.input.names[t.symbol],
    amountPerShare: t.price,
    currency: t.currency,
    exDate: t.date,
    comparison: dividendComparison(history, { date: t.date, perShare: t.price, currency: t.currency }),
    baseCurrency: ctx.input.baseCurrency,
    quantity: t.quantity,
    paidDate: t.date,
    receivedAmount: received.amount,
    receivedCurrency: received.currency,
    transactionId: t.id,
  });
}

function receivedDue(ctx: Context): { due: DueNotification[]; silent: LedgerRef[] } {
  const { today, notified, transactions } = ctx.input;
  const freshSince = addIsoDays(today, -RECEIVED_FRESH_DAYS);
  const due: DueNotification[] = [];
  const silent: LedgerRef[] = [];
  for (const t of transactions) {
    if (t.type !== 'DIVIDEND' || notified.has(ledgerId('received', t.symbol, t.id))) continue;
    if (t.date < freshSince) silent.push({ type: 'received', symbol: t.symbol, eventKey: t.id });
    else due.push(dueOf('received', t.symbol, t.id, t.date, receivedMessage(ctx, t)));
  }
  return { due, silent };
}

/**
 * An earnings summary of a held symbol is due once (`earnings#symbol#reportDate`). A backfilled one, or one older than five days, is recorded
 * silently: the first run after deploy produces the latest quarter of every holding, and that must not flood the phone.
 */
function earningsDue(ctx: Context): { due: DueNotification[]; silent: LedgerRef[] } {
  const { today, notified, earnings = [] } = ctx.input;
  const freshSince = addIsoDays(today, -EARNINGS_FRESH_DAYS);
  const due: DueNotification[] = [];
  const silent: LedgerRef[] = [];
  for (const summary of earnings) {
    if (!ctx.held.has(summary.symbol) || notified.has(ledgerId('earnings', summary.symbol, summary.reportDate))) continue;
    if (summary.origin === 'backfill' || summary.reportDate < freshSince) silent.push({ type: 'earnings', symbol: summary.symbol, eventKey: summary.reportDate });
    else due.push(dueOf('earnings', summary.symbol, summary.reportDate, summary.reportDate, buildEarningsNotification(summary)));
  }
  return { due, silent };
}

const byDueOrder = (a: DueNotification, b: DueNotification): number => a.sortKey.localeCompare(b.sortKey) || a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id);

/** Everything that is due now for one user, in the order it should be told. Throws when the transactions cannot be replayed (an oversold position). */
export function detectDueNotifications(input: DetectInput): Detection {
  const ctx = createContext(input);
  const { types } = input.settings;
  const received = types.received ? receivedDue(ctx) : { due: [], silent: [] };
  const earnings = types.earnings ? earningsDue(ctx) : { due: [], silent: [] };
  const due = [...(types.exDividend ? exDividendDue(ctx) : []), ...(types.declared ? declaredDue(ctx) : []), ...received.due, ...earnings.due];
  return { due: [...due].sort(byDueOrder), silent: [...received.silent, ...earnings.silent] };
}

export interface BaselineInput {
  today: string;
  transactions: readonly Transaction[];
  dividendEvents: readonly DividendEvent[];
  types: readonly NotificationType[];
  earnings?: readonly EarningsSummary[];
}

/**
 * What to mark as already notified when a user (or a type) is switched on, so the history is not announced: every dividend
 * transaction (`received`) and every upcoming stored event of a held symbol (`declared`). Ex-dividend reminders are not
 * baselined: an ex-date in the next days is exactly what the reminder is for.
 */
export function baselineEntries(input: BaselineInput): LedgerRef[] {
  const received = input.types.includes('received') ? receivedBaseline(input.transactions) : [];
  const declared = input.types.includes('declared') ? declaredBaseline(input) : [];
  const earnings = input.types.includes('earnings') ? earningsBaseline(input) : [];
  return [...received, ...declared, ...earnings];
}

/** Every stored summary of a held symbol: switching the type on never announces what was already there. */
function earningsBaseline({ transactions, earnings = [], today }: BaselineInput): LedgerRef[] {
  const held = heldQuantities(transactions, today);
  return earnings.filter((summary) => held.has(summary.symbol)).map((summary) => ({ type: 'earnings', symbol: summary.symbol, eventKey: summary.reportDate }));
}

const receivedBaseline = (transactions: readonly Transaction[]): LedgerRef[] =>
  transactions.filter((t) => t.type === 'DIVIDEND').map((t) => ({ type: 'received', symbol: t.symbol, eventKey: t.id }));

function declaredBaseline({ transactions, dividendEvents, today }: BaselineInput): LedgerRef[] {
  const held = heldQuantities(transactions, today);
  const entries: LedgerRef[] = [];
  for (const [symbol, events] of groupEvents(dividendEvents)) {
    if (!held.has(symbol)) continue;
    for (const event of events) if (isUpcoming(event, today)) entries.push({ type: 'declared', symbol, eventKey: event.exDate });
  }
  return entries;
}
