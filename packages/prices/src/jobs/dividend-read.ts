import { feedRetryDue, mergeDividendEvents, type DividendAttempt, type DividendEvent, type DividendFeedState } from '@portfolio/shared';
import type { FeedAnswer } from '../providers/av-dividends.js';
import { errorMessage } from '../errors.js';
import { hasExchangeSuffix } from '../symbols.js';
import { addDays } from '../time.js';
import { DIVIDEND_LOOKAHEAD_DAYS, DIVIDEND_LOOKBACK_DAYS } from './enrich.js';
import { rethrowBudget, type StepContext } from './common.js';
import { fromEodhd } from './dividend-state.js';

export interface DividendRead {
  written: number;
  attempt: DividendAttempt;
}

/** Whether the provider's answer lacks a declared upcoming dividend: nothing is ahead (the ex-date or the payment), or what is ahead has no pay date. */
export function lacksDeclared(events: readonly DividendEvent[], today: string): boolean {
  const ahead = events.filter((event) => (event.payDate ?? event.exDate) >= today);
  return ahead.every((event) => event.payDate === undefined);
}

/** What the first calls found out about the feed, written when it changes (not on every call). */
async function settleFeed(ctx: StepContext, known: DividendFeedState | undefined, answer: FeedAnswer, stamp: string): Promise<DividendEvent[]> {
  if (answer.status === 'ok') {
    if (known?.status !== 'available') await ctx.repo.putDividendFeed({ status: 'available', at: stamp, reason: '' });
    return answer.events;
  }
  if (answer.status === 'unavailable') {
    await ctx.repo.putDividendFeed({ status: 'unavailable', at: stamp, reason: answer.reason });
    ctx.logger.warn('dividend fallback unavailable on this key; asking again in a week', { reason: answer.reason });
  } else {
    ctx.logger.info('dividend fallback not used', { status: answer.status, reason: answer.reason });
  }
  return [];
}

/**
 * The fallback's dividends of one US symbol. Probe first: the feed is used only after a real call succeeded on this key; a premium refusal records
 * "unavailable" and the next try is a week later. A failure of the fallback is never a failure of the check: it only leaves the provider's answer as it was.
 */
async function fallbackEvents(ctx: StepContext, symbol: string, today: string, stamp: string): Promise<DividendEvent[]> {
  const feed = ctx.md.dividendFeed;
  // The fallback is best effort: when the step has no call left (the provider's retries used them) the next read of the symbol may have one.
  if (feed === undefined || hasExchangeSuffix(symbol) || !ctx.hasCalls(1)) return [];
  try {
    const known = await ctx.repo.getDividendFeed();
    if (known?.status === 'unavailable' && !feedRetryDue(known, new Date(stamp))) return [];
    const answer = await feed.fetch(symbol, addDays(today, -DIVIDEND_LOOKBACK_DAYS), addDays(today, DIVIDEND_LOOKAHEAD_DAYS));
    return await settleFeed(ctx, known, answer, stamp);
  } catch (error) {
    rethrowBudget(error);
    ctx.logger.warn('dividend fallback failed', { symbol, error: errorMessage(error) });
    return [];
  }
}

/**
 * Reads and stores the dividends of one symbol: the provider's (EODHD), and, when `fallback` allows it and the provider lists no declared
 * upcoming dividend, the free Alpha Vantage feed. Both are merged by ex-date (the more complete record wins; the provider's on a tie).
 * Throws what the provider throws.
 */
export async function readDividends(ctx: StepContext, symbol: string, today: string, stamp: string, fallback: boolean): Promise<DividendRead> {
  const source = ctx.md.actions!;
  const events = fromEodhd(await source.getDividends(symbol, addDays(today, -DIVIDEND_LOOKBACK_DAYS), addDays(today, DIVIDEND_LOOKAHEAD_DAYS)));
  const extra = fallback && lacksDeclared(events, today) ? await fallbackEvents(ctx, symbol, today, stamp) : [];
  const all = mergeDividendEvents(extra, events);
  const written = await ctx.repo.putDividends(all);
  const outcome = all.length > 0 ? 'ok' : 'none';
  return { written, attempt: { at: stamp, outcome, reason: '', source: extra.length > 0 ? 'alphavantage' : 'eodhd', events: all.length } };
}
