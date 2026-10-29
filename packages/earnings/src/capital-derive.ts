/**
 * The stored dividend and buyback blocks, from what was verified. Raised or cut is computed here, from two per-share amounts: the one the
 * release prints as the previous dividend, else the amount of the previous stored summary of the symbol. The model's adjective is used only
 * when no two amounts exist and the release itself says it (that was checked before). Pure.
 */
import { EARNINGS_SCHEMA_VERSION, roundTo, type EarningsBuyback, type EarningsDividend, type EarningsSummary } from '@portfolio/shared';
import type { VerifiedBuyback, VerifiedCapitalReturn, VerifiedDividend } from './capital-return.js';
import { dropUndefined } from './util.js';

/** The same cap as the summary's own list of dropped fields. */
const MAX_DROPPED_FIELDS = 20;

/** A change smaller than this share of the previous amount is no change (rounding of the printed amounts). */
export const DIVIDEND_SAME_TOLERANCE = 0.001;

/** `perShare` against `before`: raised, cut or maintained, with the change in percent and in currency. */
function compared(dividend: EarningsDividend, before: number, source: 'release' | 'stored'): EarningsDividend {
  const now = dividend.perShare!;
  const change = (now - before) / before;
  let action: 'raised' | 'cut' | 'maintained' = 'maintained';
  if (change > DIVIDEND_SAME_TOLERANCE) action = 'raised';
  else if (change < -DIVIDEND_SAME_TOLERANCE) action = 'cut';
  return {
    ...dividend,
    action,
    actionSource: 'computed',
    previousPerShare: before,
    previousSource: source,
    changePct: roundTo(change * 100, 1),
    changeAmount: roundTo(now - before, 4),
  };
}

/** The previous stored summary's declared amount, when it can be compared (same currency, a regular dividend). */
function storedAmount(previous: EarningsSummary | undefined, currency: string | undefined): number | undefined {
  const before = previous?.dividend;
  if (before?.status !== 'announced' || before.perShare === undefined || before.perShare <= 0 || before.frequency === 'special') return undefined;
  return before.currency === currency ? before.perShare : undefined;
}

/** Without the amounts that were worked out against a previous summary (the wording the release states stays). */
function withoutComputed(dividend: EarningsDividend): EarningsDividend {
  const { previousPerShare: _before, previousSource: _source, changePct: _pct, changeAmount: _amount, ...rest } = dividend;
  if (rest.actionSource !== 'computed') return rest;
  const { action: _action, actionSource: _actionSource, ...bare } = rest;
  return bare;
}

/**
 * The dividend compared with the previous stored summary of the symbol. A comparison made with an amount printed in the release is left as it
 * is. Idempotent: it starts by removing what an earlier call put there, so the backfill can call it again when an older quarter arrives.
 */
export function dividendWithPrevious(dividend: EarningsDividend, previous: EarningsSummary | undefined): EarningsDividend {
  if (dividend.status !== 'announced' || dividend.previousSource === 'release') return dividend;
  const bare = withoutComputed(dividend);
  const before = storedAmount(previous, bare.currency);
  if (before === undefined || bare.perShare === undefined || bare.frequency === 'special') return bare;
  return compared(bare, before, 'stored');
}

/** The dividend block of a summary. `currency` is the reporting currency of the summary. */
export function dividendOf(verified: VerifiedDividend, currency: string, previous: EarningsSummary | undefined): EarningsDividend {
  if (verified.status !== 'announced') return { status: verified.status };
  const base: EarningsDividend = dropUndefined({
    status: 'announced' as const,
    perShare: verified.perShare?.value,
    raw: verified.perShare?.raw,
    currency,
    action: verified.action,
    actionSource: verified.action === undefined ? undefined : ('stated' as const),
    frequency: verified.frequency,
    exDate: verified.exDate,
    recordDate: verified.recordDate,
    payDate: verified.payDate,
  });
  const printed = verified.previousPerShare?.value;
  if (printed !== undefined && printed > 0 && base.perShare !== undefined && base.frequency !== 'special') return compared(base, printed, 'release');
  return dividendWithPrevious(base, previous);
}

/** The buyback block of a summary. */
export function buybackOf(verified: VerifiedBuyback, currency: string): EarningsBuyback {
  if (verified.status !== 'announced') return { status: verified.status };
  return dropUndefined({
    status: 'announced' as const,
    currency,
    action: verified.action,
    authorization: verified.authorization?.value,
    authorizationRaw: verified.authorization?.raw,
    repurchased: verified.repurchased?.value,
    repurchasedRaw: verified.repurchased?.raw,
    repurchasedShares: verified.repurchasedShares?.value,
    remaining: verified.remaining?.value,
    remainingRaw: verified.remaining?.raw,
  });
}

/**
 * A stored summary with the dividend and buyback blocks added (the pass that reads old summaries again): every other figure stays as it was,
 * including the estimate that was joined when the release was new. What the model returned and could not be verified adds to the dropped count.
 */
export function withCapitalReturn(existing: EarningsSummary, capital: VerifiedCapitalReturn, usage: { neurons: number; calls: number }, previous: EarningsSummary | undefined): EarningsSummary {
  const comparable = previous?.reportingCurrency === existing.reportingCurrency ? previous : undefined;
  const { verification } = existing;
  return {
    ...existing,
    schemaVersion: EARNINGS_SCHEMA_VERSION,
    dividend: dividendOf(capital.dividend, existing.reportingCurrency, comparable),
    buyback: buybackOf(capital.buyback, existing.reportingCurrency),
    verification: {
      ...verification,
      dropped: verification.dropped + capital.dropped.length,
      droppedFields: [...verification.droppedFields, ...capital.dropped].slice(0, MAX_DROPPED_FIELDS),
      neuronsEstimate: verification.neuronsEstimate + usage.neurons,
      calls: verification.calls + usage.calls,
    },
  };
}
