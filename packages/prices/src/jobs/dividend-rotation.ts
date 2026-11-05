import { byText } from '../parse.js';
import type { CalendarState } from '../repository.js';
import { addDays } from '../time.js';

/** A symbol whose last stored ex-date is this close to today (before or after) is likely to get news about its dividend. */
export const NEAR_WINDOW_DAYS = 10;
/** A symbol in that window is read again after this many days (the rotation's own interval is longer). */
export const NEAR_RECHECK_DAYS = 2;
/** A quarterly payer is expected to declare this many days before its next ex-date, and a while after it when it is late. */
export const DECLARE_AHEAD_DAYS = 25;
export const QUARTER_DAYS = 91;

const MS_PER_DAY = 86_400_000;

/**
 * Why a symbol is read now: `new` (never read, or bought after its last read), `missing` (a manual check: no upcoming dividend stored),
 * `near` (its last or next ex-date is within 10 days of today, or a quarterly payer is due to declare), `stale` (its turn in the rotation).
 */
export type RotationTier = 'new' | 'missing' | 'near' | 'stale';

const TIER_RANK: Readonly<Record<RotationTier, number>> = { new: 0, missing: 1, near: 2, stale: 3 };

export interface RotationContext {
  now: Date;
  /** `scheduled`: the daily rotation (splits and dividends, every `recheckDays`); `manual`: the owner's "Check dividends now" (dividends only, every symbol is a candidate). */
  mode: 'scheduled' | 'manual';
  recheckDays: number;
  states: ReadonlyMap<string, CalendarState>;
  /** The latest ex-date on or before today and the earliest after it, per symbol that has stored dividends. */
  dates: ReadonlyMap<string, { last?: string; next?: string }>;
  /** The day of the first transaction of each held symbol. */
  heldSince: ReadonlyMap<string, string>;
}

export interface RotationEntry {
  symbol: string;
  tier: RotationTier;
  /** Whether the splits are read too (the dividends always are). */
  splits: boolean;
}

const dayOf = (iso: string): string => iso.slice(0, 10);
const gapDays = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);

/** When the dividends were last read: the later of the dividends marker and the splits marker (both are written by the daily rotation). */
const lastRead = (state: CalendarState | undefined): string => [state?.dividendsCheckedAt ?? '', state?.splitsCheckedAt ?? ''].toSorted(byText).at(-1)!;

/**
 * Never read, or bought after the last read: the symbol's dividends were not looked at since it is held. The daily rotation counts only its own full
 * reads (the enrichment also reads the dividends once, but not the splits, and a freshly bought symbol still needs its turn); a manual check counts any read.
 */
function isNew(mode: RotationContext['mode'], state: CalendarState | undefined, since: string | undefined): boolean {
  const read = mode === 'scheduled' ? (state?.splitsCheckedAt ?? '') : lastRead(state);
  return read === '' || (since !== undefined && dayOf(read) < since);
}

/** Whether news about the dividend is likely now: an ex-date close by, or a quarterly payer that should declare about now. */
function isNear(today: string, dates: { last?: string; next?: string } | undefined): boolean {
  if (dates === undefined) return false;
  const close = (date: string | undefined): boolean => date !== undefined && Math.abs(gapDays(today, date)) <= NEAR_WINDOW_DAYS;
  if (close(dates.last) || close(dates.next)) return true;
  if (dates.next !== undefined || dates.last === undefined) return false;
  const expected = addDays(dates.last, QUARTER_DAYS);
  return expected >= addDays(today, -NEAR_WINDOW_DAYS) && expected <= addDays(today, DECLARE_AHEAD_DAYS);
}

/** The symbol's tier, or null when it is not to be read now. */
function tierOf(symbol: string, ctx: RotationContext, today: string): { tier: RotationTier; splits: boolean } | null {
  const state = ctx.states.get(symbol);
  const read = lastRead(state);
  const cutoff = new Date(ctx.now.getTime() - ctx.recheckDays * MS_PER_DAY).toISOString();
  const splitsDue = (state?.splitsCheckedAt ?? '') < cutoff;
  if (ctx.mode === 'manual') {
    if (isNew(ctx.mode, state, ctx.heldSince.get(symbol))) return { tier: 'new', splits: false };
    const dates = ctx.dates.get(symbol);
    if (dates?.next === undefined) return { tier: 'missing', splits: false };
    return { tier: isNear(today, dates) ? 'near' : 'stale', splits: false };
  }
  // A symbol that failed within the interval waits its turn like any other: a broken ticker must not be retried first every day.
  const failedRecently = (state?.splitsFailedAt ?? '') >= cutoff;
  if (!failedRecently && isNew(ctx.mode, state, ctx.heldSince.get(symbol))) return { tier: 'new', splits: splitsDue };
  const recent = read >= new Date(ctx.now.getTime() - NEAR_RECHECK_DAYS * MS_PER_DAY).toISOString();
  if (!recent && isNear(today, ctx.dates.get(symbol))) return { tier: 'near', splits: splitsDue };
  return splitsDue ? { tier: 'stale', splits: true } : null;
}

/**
 * The symbols to read, most urgent first: newly held or never read symbols, then (a manual check) symbols with no upcoming dividend stored, then
 * symbols whose ex-date is close or whose quarterly dividend should be declared about now, then the stalest. Within a tier the least recently
 * attempted symbol goes first, and a symbol whose last attempt failed goes behind the others, so one broken ticker cannot use up the daily budget.
 */
export function planRotation(symbols: readonly string[], ctx: RotationContext): RotationEntry[] {
  const today = dayOf(ctx.now.toISOString());
  const attempted = (symbol: string): string => {
    const state = ctx.states.get(symbol);
    return [lastRead(state), state?.splitsFailedAt ?? ''].toSorted(byText).at(-1)!;
  };
  return symbols
    .flatMap((symbol) => {
      const found = tierOf(symbol, ctx, today);
      return found === null ? [] : [{ symbol, ...found }];
    })
    .toSorted((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || byText(attempted(a.symbol), attempted(b.symbol)) || byText(a.symbol, b.symbol));
}
