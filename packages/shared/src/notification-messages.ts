/**
 * The text of the dividend push notifications. Pure and English: the same builders run on the server (the notification job) and in
 * tests, and dates follow the app's rule (numeric `dd-mm-yyyy`, see "Date format" in docs/architecture.md). Parts that cannot be
 * computed (a comparison without a reference payment, the amount for your shares without a quantity) are left out, never guessed.
 */
import { daysBetween, roundTo } from './analytics.js';
import type { DividendComparison } from './dividend-comparison.js';
import type { PushNotificationPayload } from './notifications.js';

export const MAX_TITLE_LENGTH = 90;
export const MAX_BODY_LENGTH = 240;
/** More than this many due items at once are sent as one summary. */
export const MAX_SEPARATE_NOTIFICATIONS = 3;
const MAX_NAME_LENGTH = 24;

/** `2026-11-06` -> `06-11-2026`. */
export const formatNoticeDate = (iso: string): string => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };

function groupThousands(integer: string): string {
  let out = '';
  for (let i = 0; i < integer.length; i++) {
    if (i > 0 && (integer.length - i) % 3 === 0) out += ',';
    out += integer[i];
  }
  return out;
}

/** `1234.5`, 2 decimals -> `1,234.50`. Trailing zeros beyond `minDecimals` are dropped. */
function formatNumber(value: number, minDecimals: number, maxDecimals: number): string {
  const rounded = roundTo(value, maxDecimals);
  const [integer = '0', fraction = ''] = Math.abs(rounded).toFixed(maxDecimals).split('.');
  let kept = fraction;
  while (kept.length > minDecimals && kept.endsWith('0')) kept = kept.slice(0, -1);
  const decimals = kept === '' ? '' : `.${kept}`;
  return [rounded < 0 ? '-' : '', groupThousands(integer), decimals].join('');
}

/** `$1.28`, `€0.0275`, `CAD 1.28`: the amount per share in the payment's own currency. */
export function formatPerShare(value: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency];
  const amount = formatNumber(value, 2, 4);
  return symbol ? `${symbol}${amount}` : `${currency} ${amount}`;
}

/** `EUR 7.74`: a total in a currency code. */
export const formatTotal = (value: number, currency: string): string => `${currency} ${formatNumber(value, 2, 2)}`;

const formatShares = (quantity: number): string => `${formatNumber(quantity, 0, 4)} ${quantity === 1 ? 'share' : 'shares'}`;

/** `+2.4 %`, `-1.3 %`, `0.0 %`: explicit sign, one decimal. */
export function formatSignedPct(pct: number): string {
  const text = formatNumber(Math.abs(pct), 1, 1);
  let sign = '';
  if (pct > 0) sign = '+';
  else if (pct < 0) sign = '-';
  return `${sign}${text} %`;
}

const LEGAL_SUFFIXES: ReadonlySet<string> = new Set(['inc', 'inc.', 'incorporated', 'corp', 'corp.', 'corporation', 'co', 'co.', 'company', 'ltd', 'ltd.', 'limited', 'plc', 'n.v.', 'nv', 's.a.', 'sa', 'ag', 'se', 'holding', 'holdings', 'group']);

/** The company name without its legal suffix and cut to 24 characters; the symbol when no name is known. */
export function shortName(symbol: string, name?: string): string {
  const words = (name ?? '').replaceAll(',', ' ').split(' ').filter((word) => word !== '');
  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1)!.toLowerCase())) words.pop();
  const short = words.join(' ');
  if (short === '') return symbol;
  return short.length > MAX_NAME_LENGTH ? `${short.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…` : short;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** What the previous payment is called, by how long ago it was: a month, a quarter, half a year, or just "the previous payment". */
export function previousPeriodLabel(days: number): string {
  if (days <= 45) return 'last month';
  if (days <= 135) return 'last quarter';
  if (days <= 230) return 'last half year';
  return 'the previous payment';
}

/**
 * The comparison phrases, e.g. `['+2.4 % vs last quarter', '+5.8 % vs a year ago']`. For an annual payer the previous payment *is* the
 * one a year ago: it is said once. `eventDate` is the date the history is keyed by (ex-date, or the payment date of a received dividend).
 */
export function comparisonParts(comparison: DividendComparison, eventDate: string): string[] {
  const { vsPrevious, vsYearAgo } = comparison;
  const parts: string[] = [];
  if (vsPrevious && vsPrevious.previousDate !== vsYearAgo?.yearAgoDate) {
    parts.push(`${formatSignedPct(vsPrevious.pct)} vs ${previousPeriodLabel(daysBetween(vsPrevious.previousDate, eventDate))}`);
  }
  if (vsYearAgo) parts.push(`${formatSignedPct(vsYearAgo.pct)} vs a year ago`);
  return parts;
}

/** The one percentage a summary line shows: against the previous payment when known, else against a year ago. */
const headlinePct = (comparison: DividendComparison): number | undefined => comparison.vsPrevious?.pct ?? comparison.vsYearAgo?.pct;

export interface DividendNotice {
  symbol: string;
  name?: string;
  amountPerShare: number;
  currency: string;
  exDate: string;
  payDate?: string;
  comparison: DividendComparison;
  /** Date the comparison history is keyed by (the ex-date for declared and ex-dividend notices). Defaults to `exDate`. */
  comparisonDate?: string;
  baseCurrency: string;
  /** Shares held and the expected net amount for them in the base currency (omitted when unknown). */
  quantity?: number;
  expectedAmount?: number;
}

export interface ReceivedNotice extends DividendNotice {
  /** The booked payment date. */
  paidDate: string;
  /** Net amount received, in the base currency when it can be converted, else in the payment's own currency. */
  receivedAmount: number;
  receivedCurrency: string;
  transactionId: string;
}

/** A message plus the one-line form a summary notification uses for it. */
export interface NotificationMessage {
  payload: PushNotificationPayload;
  line: string;
}

const assetUrl = (symbol: string): string => `/assets/${encodeURIComponent(symbol)}`;

function build(type: 'exDividend' | 'declared' | 'received', symbol: string, tagDate: string, title: string, body: string, line: string): NotificationMessage {
  return {
    payload: { type, symbol, title: truncate(title, MAX_TITLE_LENGTH), body: truncate(body, MAX_BODY_LENGTH), url: assetUrl(symbol), tag: `${type}:${symbol}:${tagDate}` },
    line,
  };
}

const withPct = (text: string, comparison: DividendComparison): string => {
  const pct = headlinePct(comparison);
  return pct === undefined ? text : `${text} (${formatSignedPct(pct)})`;
};

/** A new dividend was declared (or an estimate became confirmed). */
export function buildDeclaredNotification(notice: DividendNotice): NotificationMessage {
  const label = shortName(notice.symbol, notice.name);
  const perShare = formatPerShare(notice.amountPerShare, notice.currency);
  const dates = notice.payDate ? `Ex-date ${formatNoticeDate(notice.exDate)}, pay ${formatNoticeDate(notice.payDate)}` : `Ex-date ${formatNoticeDate(notice.exDate)}`;
  const forShares =
    notice.quantity !== undefined && notice.expectedAmount !== undefined ? [`about ${formatTotal(notice.expectedAmount, notice.baseCurrency)} for your ${formatShares(notice.quantity)}`] : [];
  const body = [dates, ...comparisonParts(notice.comparison, notice.comparisonDate ?? notice.exDate), ...forShares].join(' · ');
  return build('declared', notice.symbol, notice.exDate, `${label} declared ${perShare} per share`, body, withPct(`${label} declared ${perShare}`, notice.comparison));
}

const inDays = (days: number): string => (days === 1 ? 'tomorrow' : `in ${days} days`);

/** The ex-dividend date is `daysUntil` days away. */
export function buildExDividendNotification(notice: DividendNotice, daysUntil: number): NotificationMessage {
  const label = shortName(notice.symbol, notice.name);
  const perShare = `${formatPerShare(notice.amountPerShare, notice.currency)} per share`;
  const body = [perShare, ...comparisonParts(notice.comparison, notice.comparisonDate ?? notice.exDate)].join(', ');
  const title = `${label} goes ex-dividend ${inDays(daysUntil)} (${formatNoticeDate(notice.exDate)})`;
  return build('exDividend', notice.symbol, notice.exDate, title, body, withPct(`${label} ex-dividend ${inDays(daysUntil)}`, notice.comparison));
}

/** A dividend payment was booked. */
export function buildReceivedNotification(notice: ReceivedNotice): NotificationMessage {
  const label = shortName(notice.symbol, notice.name);
  const received = formatTotal(notice.receivedAmount, notice.receivedCurrency);
  const perShare = `${formatPerShare(notice.amountPerShare, notice.currency)} per share`;
  const body = [perShare, ...comparisonParts(notice.comparison, notice.comparisonDate ?? notice.paidDate)].join(', ');
  return build('received', notice.symbol, `${notice.paidDate}:${notice.transactionId}`, `${label} dividend received: ${received}`, body, withPct(`${label} received ${received}`, notice.comparison));
}

/** One notification for many due items: the title counts them, the body lists the first three, a tap opens the calendar. */
export function buildSummaryNotification(lines: readonly string[], today: string): PushNotificationPayload {
  const listed = lines.slice(0, MAX_SEPARATE_NOTIFICATIONS);
  const rest = lines.length - listed.length;
  const body = [...listed, ...(rest > 0 ? [`and ${rest} more`] : [])].join(' · ');
  return { type: 'summary', symbol: '', title: `${lines.length} dividend updates`, body: truncate(body, MAX_BODY_LENGTH), url: '/calendar', tag: `summary:${today}:${lines.length}` };
}

/** The payload of the "Send a test notification" button. */
export const TEST_NOTIFICATION: PushNotificationPayload = {
  type: 'test',
  symbol: '',
  title: 'Test notification',
  body: 'Dividend notifications work on this device.',
  url: '/settings/notifications',
  tag: 'test',
};
