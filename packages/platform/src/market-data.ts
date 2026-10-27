import type {
  DividendEvent,
  EodPrice,
  FxDay,
  FxRates,
  InstrumentProfile,
  Quote,
  StoredEarningsEvent,
  StoredSplitEvent,
  TransactionsChangedDetail,
} from '@portfolio/shared';

/**
 * Market-data contract: the interface the TypeScript port of the Python price service (services/prices) implements,
 * so the price/FX/calendar refresh is written once for every platform. The operations mirror the Python handlers
 * (`prices/handlers.py`, `prices/calendar_handlers.py`) and the provider protocols (`prices/providers/base.py`,
 * `prices/calendar_providers.py`). Dates are `YYYY-MM-DD`, timestamps ISO-8601 UTC.
 *
 * The jobs are resumable (see `JobStep`): a refresh walks the due symbols in chunks that fit one invocation, persisting
 * its position in the job cursor, so a free-tier Worker (10 ms CPU, 50 subrequests) can run them.
 */

/** A symbol that a provider could not serve. */
export interface ProviderFailure {
  symbol: string;
  /** Error class name or provider message; never an API key. */
  error: string;
}

/** Outcome of a multi-symbol quote fetch, so callers can count refreshed / skipped / failed. */
export interface QuoteBatch {
  quotes: Record<string, Quote>;
  failed: ProviderFailure[];
  /** Symbols the provider does not know. */
  unavailable: string[];
}

/** One listing of an instrument on an exchange, as a provider's search by ISIN returns it. */
export interface ListingMatch {
  /** The canonical symbol of the listing (`FWRA.DE`). */
  symbol: string;
  /** The suffix of the exchange (`DE`, `AS`, `L`). */
  exchange: string;
  /** The currency the listing is quoted in, as the provider says it (`EUR`, `GBX`, `USD`). */
  currency: string;
  isin: string;
  name: string;
}

export interface MarketDataProvider {
  readonly name: string;
  getQuotes(symbols: readonly string[]): Promise<QuoteBatch>;
  getEodHistory(symbol: string, start: string, end: string): Promise<EodPrice[]>;
  getProfile(symbol: string): Promise<InstrumentProfile | null>;
  getDividends(symbol: string, start: string, end: string): Promise<DividendEvent[]>;
  /** The listings of the instrument with this ISIN on the exchanges the provider covers (one search call); absent when it cannot search. */
  searchListings?(isin: string): Promise<ListingMatch[]>;
}

/** The per-symbol price provider (quotes, EOD history, profile, dividends) under its operational name. */
export type PriceProvider = MarketDataProvider;

export interface FxProvider {
  readonly name: string;
  getLatest(base: string): Promise<FxRates>;
  getHistory(base: string, start: string, end: string): Promise<FxDay[]>;
}

/** Upcoming earnings of the tracked symbols; at most one provider call. */
export interface EarningsSource {
  readonly name: string;
  /** Whether the daily call budget applies (false for the offline mock). */
  readonly budgeted: boolean;
  /** `names` are the profile names of the symbols, used to vouch for a listing that is not the source's own ticker. */
  fetch(symbols: readonly string[], today: string, names?: ReadonlyMap<string, string>): Promise<StoredEarningsEvent[]>;
}

export interface CorporateActionsSource {
  readonly name: string;
  readonly budgeted: boolean;
  getSplits(symbol: string, start: string): Promise<StoredSplitEvent[]>;
  getDividends(symbol: string, start: string, end: string): Promise<DividendEvent[]>;
}

export interface ScheduledRefreshSummary {
  refreshed: number;
  skipped: number;
  failed: number;
  fxUpdated: boolean;
  fxDaysWritten: number;
  fxHistoryOk: boolean;
  profileDetailsRefreshed: number;
  eventPublished: boolean;
  /** Whether the run fell in the hours in which EU-listed symbols are refreshed. */
  euWindow: boolean;
  failedSymbols: string[];
  skippedSymbols: string[];
}

export interface EnrichmentSummary {
  symbols: number;
  alreadyEnriched: number;
  enriched: string[];
  /** Symbols that failed transiently and are redelivered. */
  retry: string[];
}

export interface FxBackfillSummary {
  base: string;
  start: string;
  end: string;
  fxDaysWritten: number;
  lastDay: string | null;
}

export type CalendarStatus = 'ok' | 'no-provider' | 'no-symbols' | 'budget-exhausted' | 'rate-limited' | 'failed';

export interface CalendarRefreshSummary {
  tracked: number;
  earnings: { status: CalendarStatus; symbols?: number; events?: number; staleDeleted?: number; error?: string };
  corporateActions: { status: CalendarStatus; checked?: number; splits?: number; dividends?: number; failed?: number };
}

/** What the scheduled and event-driven price jobs do. `now` is injected so runs are reproducible. */
export interface MarketDataService {
  /** `refreshPrices` job: FX (latest + daily history), quotes of the due symbols, profile details; emits PricesUpdated. */
  refreshScheduled(now: Date): Promise<ScheduledRefreshSummary>;
  /** `enrichTransactions` job: profile, EOD history and quote of symbols that were never enriched. */
  enrichSymbols(event: Pick<TransactionsChangedDetail, 'symbols'>, now: Date): Promise<EnrichmentSummary>;
  /** Stores the ECB daily fixings from `start` (default: the day after the latest stored one) through `today`. */
  backfillFxHistory(today: string, start?: string): Promise<FxBackfillSummary>;
  /** `refreshCalendar` job: earnings dates for every tracked ticker, splits/dividends for a budgeted rotating subset. */
  refreshCalendar(now: Date): Promise<CalendarRefreshSummary>;
}
