import { majorCurrencyCode, proxySourceOf, isProxySource, type EodPrice, type HistoryOverrideStatus, type InstrumentProfile } from '@portfolio/shared';
import { ProviderUnavailableError, SymbolNotFoundError } from '../errors.js';
import { currencyFor } from '../symbols.js';
import { addDays } from '../time.js';
import type { HistorySymbolRecord } from '../repository.js';
import { rethrowBudget, type StepContext } from './common.js';

/** Days of history fetched under an override: the same window as the symbol's own history. */
const OVERRIDE_HISTORY_DAYS = 365;
/** Newest rows of the held symbol read to find the days that already have a row of their own. */
const OWN_ROWS_READ = 400;

export const NO_DATA_REASON = 'the provider has no data for the history symbol';
export const NO_PROVIDER_REASON = 'no market-data provider is set up for the history symbol';

interface Outcome {
  status: HistoryOverrideStatus;
  reason: string | null;
}

/** `history symbol is quoted in USD, the holding in EUR`: the numbers of another currency are never stored (no conversion is made). */
export const currencyMismatchReason = (quoted: string, held: string): string => `history symbol is quoted in ${quoted}, the holding in ${held}`;

/** The days that have a row the owner's history symbol must not replace: a provider's own, the broker's. Automatic proxy rows and earlier override rows may be replaced. */
export async function daysWithOwnRows(ctx: StepContext, symbol: string): Promise<Set<string>> {
  const newest = await ctx.repo.newestEod(symbol, OWN_ROWS_READ);
  return new Set(newest.filter((row) => !isProxySource(row.source)).map((row) => row.date));
}

async function record(ctx: StepContext, stored: HistorySymbolRecord, outcome: Outcome): Promise<void> {
  if (stored.status === outcome.status && stored.reason === outcome.reason) return;
  await ctx.repo.putHistorySymbol({ ...stored, ...outcome });
}

/** The rows under the history symbol, or why there are none (the provider has no data or no provider serves the symbol); an outage or a rate limit propagates. */
async function fetchRows(ctx: StepContext, historySymbol: string, today: string): Promise<{ rows: EodPrice[] } | { reason: string }> {
  try {
    const rows = await ctx.md.provider.getEodHistory(historySymbol, addDays(today, -OVERRIDE_HISTORY_DAYS), today);
    return rows.length === 0 ? { reason: NO_DATA_REASON } : { rows };
  } catch (error) {
    rethrowBudget(error);
    if (error instanceof SymbolNotFoundError) return { reason: NO_DATA_REASON };
    if (error instanceof ProviderUnavailableError) return { reason: NO_PROVIDER_REASON };
    throw error;
  }
}

/**
 * The currency of the position (its stored profile, else the one the exchange suffix implies) and the currency of the rows, both as
 * major units. Rows of another currency are refused: a fund quoted in USD says nothing about a position in EUR.
 */
function mismatch(symbol: string, profile: Readonly<InstrumentProfile> | undefined, rows: readonly EodPrice[]): string | null {
  const held = majorCurrencyCode((profile?.currency ?? currencyFor(symbol)).toUpperCase());
  const quoted = majorCurrencyCode((rows.at(-1)?.currency ?? held).toUpperCase());
  return quoted === held ? null : currencyMismatchReason(quoted, held);
}

export interface OverrideHistory {
  /** The rows to store, null when there is none to store. */
  rows: EodPrice[] | null;
  /** The owner named the held symbol itself as its history symbol: no other listing is to be guessed. */
  heldListing: boolean;
}

const NONE: OverrideHistory = { rows: null, heldListing: false };

/**
 * The end-of-day history of a held symbol taken from the history symbol the owner set (`FWRA.DE` for the Milan line), stored under the
 * held symbol with `source: 'eodhd:<HISTORY SYMBOL>'` and `override: true`, or null when there is none to store: no override, the held
 * symbol itself, no data, another currency, or no day left that has no row of its own. What became of it is recorded on the override
 * item (the coverage report shows it). Costs one provider call; a rate limit or an outage propagates to the job.
 */
export async function overrideHistory(ctx: StepContext, symbol: string, profile: Readonly<InstrumentProfile> | undefined, today: string): Promise<OverrideHistory> {
  const stored = await ctx.repo.getHistorySymbol(symbol);
  if (stored === undefined) return NONE;
  if (stored.historySymbol === symbol) {
    await record(ctx, stored, { status: 'own', reason: null });
    return { rows: null, heldListing: true };
  }
  const fetched = await fetchRows(ctx, stored.historySymbol, today);
  if ('reason' in fetched) {
    await record(ctx, stored, { status: 'no-data', reason: fetched.reason });
    return NONE;
  }
  const refusal = mismatch(symbol, profile, fetched.rows);
  if (refusal !== null) {
    ctx.logger.warn('history symbol refused', { symbol, historySymbol: stored.historySymbol, reason: refusal });
    await record(ctx, stored, { status: 'refused', reason: refusal });
    return NONE;
  }
  await record(ctx, stored, { status: 'applied', reason: null });
  const own = await daysWithOwnRows(ctx, symbol);
  const source = proxySourceOf(stored.historySymbol);
  const rows = fetched.rows.filter((row) => !own.has(row.date)).map((row): EodPrice => ({ ...row, symbol, source, override: true }));
  ctx.logger.info('history from the symbol the owner set', { symbol, historySymbol: stored.historySymbol, rows: rows.length });
  return { rows, heldListing: false };
}
