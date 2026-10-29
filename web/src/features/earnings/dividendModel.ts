/**
 * What an earnings card says about the dividend and the share buybacks, as plain data (the component only draws it). A summary stored before
 * the two blocks existed has neither: it says "not read yet" until the backfill has read it again. A release that announces nothing says N/A
 * and why; a release that mentions an amount the app could not verify says so instead of guessing.
 */
import type { EarningsBackfillStatus, EarningsBuyback, EarningsDividend, EarningsSummary } from '@portfolio/shared';
import { formatDate, formatMoney, formatPercent } from '../../lib/format';
import { compactCount, formatMetric } from './earningsModel';

export const NOT_READ_YET = 'not read yet';
export const NO_DIVIDEND = 'No dividend announced';
export const NO_BUYBACK = 'No share buyback mentioned';
export const NOT_RELIABLE = 'mentioned in the release but could not be read reliably, see the source';

export type CapitalReturnIcon = 'up' | 'down' | 'same' | 'new' | 'stop';

export interface CapitalReturnLine {
  key: 'dividend' | 'buyback' | 'unread';
  label: string;
  /** The words after the label. */
  text: string;
  /** Why a line says N/A (shown next to it, in muted text). */
  note?: string;
  /** Raised, cut and so on is told by this icon (next to its words, never by colour alone). */
  icon?: CapitalReturnIcon;
  tone: 'announced' | 'none' | 'unclear' | 'unread';
}

const ICONS: Readonly<Record<NonNullable<EarningsDividend['action']>, CapitalReturnIcon>> = { raised: 'up', cut: 'down', maintained: 'same', initiated: 'new', suspended: 'stop' };

const perShare = (value: number, currency: string): string => formatMoney(value, currency, { maxDigits: 4 });

/** `raised 4,7% (+US$ 0,02)`, `cut 50% (−US$ 0,30)`, `maintained`, `initiated`, `suspended`. */
export function actionText(dividend: EarningsDividend): string | undefined {
  const { action } = dividend;
  if (action === undefined) return undefined;
  if (action !== 'raised' && action !== 'cut') return action;
  const parts: string[] = [];
  if (dividend.changePct !== undefined) parts.push(formatPercent(Math.abs(dividend.changePct), { digits: 1 }));
  if (dividend.changeAmount !== undefined) parts.push(`(${action === 'raised' ? '+' : '−'}${perShare(Math.abs(dividend.changeAmount), dividend.currency ?? 'USD')})`);
  return [action, ...parts].join(' ');
}

/** `paid 15-01-2027 to holders of record 02-01-2027`, with the ex-dividend date when it differs or stands alone. */
export function datesText(dividend: EarningsDividend): string | undefined {
  const { exDate, recordDate, payDate } = dividend;
  const parts: string[] = [];
  if (payDate !== undefined) parts.push(`paid ${formatDate(payDate)}`);
  if (recordDate !== undefined) parts.push(`${payDate === undefined ? '' : 'to '}holders of record ${formatDate(recordDate)}`);
  if (exDate !== undefined && exDate !== recordDate) parts.push(`ex-dividend ${formatDate(exDate)}`);
  return parts.length === 0 ? undefined : parts.join(' ');
}

export function dividendLine(dividend: EarningsDividend): CapitalReturnLine {
  const base = { key: 'dividend' as const, label: 'Dividend' };
  if (dividend.status === 'none') return { ...base, text: 'N/A', note: NO_DIVIDEND, tone: 'none' };
  if (dividend.status === 'not-found') return { ...base, text: NOT_RELIABLE, tone: 'unclear' };
  const frequency = dividend.frequency === undefined ? '' : ` (${dividend.frequency})`;
  const amount = dividend.perShare === undefined ? undefined : `${perShare(dividend.perShare, dividend.currency ?? 'USD')} per share${frequency}`;
  const change = [amount, actionText(dividend)].filter((part) => part !== undefined).join(', ');
  const text = [change, datesText(dividend)].filter((part) => part !== undefined && part !== '').join(', ');
  return { ...base, text: text === '' ? 'announced with the results' : text, tone: 'announced', ...(dividend.action === undefined ? {} : { icon: ICONS[dividend.action] }) };
}

const money = (value: number, currency: string): string => formatMetric(value, 'money', currency);

/** `new $2B authorization`, `authorization increased to $1.5B`, `$1B program`. */
function authorizationText(buyback: EarningsBuyback, currency: string): string | undefined {
  if (buyback.authorization === undefined) return undefined;
  const size = money(buyback.authorization, currency);
  if (buyback.action === 'new') return `new ${size} authorization`;
  if (buyback.action === 'increased') return `authorization increased to ${size}`;
  return `${size} program`;
}

/** `repurchased $120M (1.8M shares) this quarter`, or the shares alone. */
function repurchasedText(buyback: EarningsBuyback, currency: string): string | undefined {
  const shares = buyback.repurchasedShares === undefined ? undefined : `${compactCount(buyback.repurchasedShares)} shares`;
  if (buyback.repurchased === undefined) return shares === undefined ? undefined : `repurchased ${shares} this quarter`;
  const inShares = shares === undefined ? '' : ` (${shares})`;
  return `repurchased ${money(buyback.repurchased, currency)}${inShares} this quarter`;
}

export function buybackLine(buyback: EarningsBuyback): CapitalReturnLine {
  const base = { key: 'buyback' as const, label: 'Share buybacks' };
  if (buyback.status === 'none') return { ...base, text: 'N/A', note: NO_BUYBACK, tone: 'none' };
  if (buyback.status === 'not-found') return { ...base, text: NOT_RELIABLE, tone: 'unclear' };
  const currency = buyback.currency ?? 'USD';
  const remaining = buyback.remaining === undefined ? undefined : `${money(buyback.remaining, currency)} authorization remaining`;
  const parts = [authorizationText(buyback, currency), repurchasedText(buyback, currency), remaining].filter((part): part is string => part !== undefined);
  return { ...base, text: parts.length === 0 ? 'announced with the results' : parts.join('; '), tone: 'announced', ...(buyback.action === 'new' || buyback.action === 'increased' ? { icon: 'new' as const } : {}) };
}

/** The lines of a card: both, or the one line that says the summary has not been read for them yet. */
export function capitalReturnLines(summary: EarningsSummary): CapitalReturnLine[] {
  if (summary.dividend === undefined || summary.buyback === undefined) return [{ key: 'unread', label: 'Dividend and buyback', text: NOT_READ_YET, tone: 'unread' }];
  return [dividendLine(summary.dividend), buybackLine(summary.buyback)];
}

/** The pass that reads stored summaries again for the dividend and the buyback, next to the progress of the backfill; nothing when there is none. */
export function upgradeText(backfill: EarningsBackfillStatus | undefined): string | undefined {
  const upgrade = backfill?.upgrade;
  if (upgrade === undefined) return undefined;
  if (upgrade.done >= upgrade.total) return `Dividend and buyback: read for all ${upgrade.total} stored quarters.`;
  return `Dividend and buyback: read for ${upgrade.done} of ${upgrade.total} stored quarters so far. Quarters stored before this was added are read again, a few at a time, within the free daily AI allowance.`;
}
