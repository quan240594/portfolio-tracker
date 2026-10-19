import type { DividendEvent, EodPrice, FxDay, InstrumentProfile, Quote } from '@portfolio/shared';
import type { FxProvider, MarketDataProvider, ProviderFailure, QuoteBatch } from '@portfolio/platform';
import { ProviderError, RateLimitError, SymbolNotFoundError } from '../errors.js';
import { byText } from '../parse.js';

export type { FxProvider, MarketDataProvider, ProviderFailure, QuoteBatch };

export type FailureKind = 'not-found' | 'rate-limited' | 'error';

/** A symbol a provider could not serve, with what a caller needs to decide about a retry. */
export interface QuoteFailure extends ProviderFailure {
  retryable: boolean;
  kind: FailureKind;
}

export interface PriceBatch extends QuoteBatch {
  failed: QuoteFailure[];
}

/** The platform's price provider with the richer quote outcome the jobs use. */
export interface PriceSource extends MarketDataProvider {
  getQuotes(symbols: readonly string[]): Promise<PriceBatch>;
}

/** Latest ECB reference rates; `date` is the fixing day they belong to (not part of the stored `FX#{base}` item). */
export interface FxLatest {
  base: string;
  rates: Record<string, number>;
  asOf: string;
  date?: string;
}

export interface FxSource extends FxProvider {
  getLatest(base: string): Promise<FxLatest>;
  /** The fixings of one year-bounded range (one request); the unit of a resumable backfill. */
  getHistoryChunk(base: string, start: string, end: string): Promise<FxDay[]>;
}

export function failureOf(symbol: string, error: ProviderError): QuoteFailure {
  let kind: FailureKind = 'error';
  if (error instanceof SymbolNotFoundError) kind = 'not-found';
  else if (error instanceof RateLimitError) kind = 'rate-limited';
  return { symbol, error: error.message, retryable: error.retryable, kind };
}

export const notFound = (provider: string, symbol: string): QuoteFailure => failureOf(symbol, new SymbolNotFoundError(`${provider}: no quote for ${symbol}`, { provider, symbol }));

/**
 * Turns a provider's "quotes that were found" call into the batch outcome: a ProviderError fails every symbol with that
 * error, a symbol missing from the answer is "not found". Other errors are bugs and propagate.
 */
export async function quotesToBatch(provider: string, symbols: readonly string[], fetchQuotes: (symbols: readonly string[]) => Promise<Record<string, Quote>>): Promise<PriceBatch> {
  let quotes: Record<string, Quote>;
  try {
    quotes = await fetchQuotes(symbols);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return { quotes: {}, failed: symbols.map((symbol) => failureOf(symbol, error)), unavailable: [] };
  }
  return { quotes, failed: symbols.filter((symbol) => !(symbol in quotes)).map((symbol) => notFound(provider, symbol)), unavailable: [] };
}

/** Filters to [start, end], de-duplicates by date (the last row wins) and sorts ascending. */
export function clampRange(rows: readonly EodPrice[], start: string, end: string): EodPrice[] {
  const byDate = new Map<string, EodPrice>();
  for (const row of rows) if (row.date >= start && row.date <= end) byDate.set(row.date, row);
  return [...byDate.keys()].toSorted(byText).map((date) => byDate.get(date)!);
}

export type ProfileLookup = (symbol: string) => Promise<InstrumentProfile | null>;
export type DividendLookup = (symbol: string, start: string, end: string) => Promise<DividendEvent[]>;
