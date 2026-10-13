/**
 * EventBridge contract. Custom bus name comes from env EVENT_BUS_NAME.
 *
 * Flows:
 *  1. S3 "Object Created" (default bus, prefix imports/) -> rule -> SQS ingest-queue -> ingest Lambda
 *  2. ingest Lambda / API -> TransactionsChanged (custom bus) -> rule -> SQS enrich-queue -> prices `on_transactions_changed`
 *  3. EventBridge Scheduler (cron) -> prices `scheduled_refresh` -> PricesUpdated (custom bus)
 */
export const EVENT_SOURCES = {
  api: 'portfolio.api',
  ingest: 'portfolio.ingest',
  prices: 'portfolio.prices',
} as const;

export const DETAIL_TYPES = {
  transactionsChanged: 'TransactionsChanged',
  pricesUpdated: 'PricesUpdated',
} as const;

export interface TransactionsChangedDetail {
  userId: string;
  portfolioId: string;
  symbols: string[];
  reason: 'CREATED' | 'DELETED' | 'IMPORTED';
  importId?: string;
}

export interface PricesUpdatedDetail {
  symbols: string[];
  asOf: string;
  /** "scheduled" for the cron refresh, "enrichment" for newly tracked tickers. */
  trigger: 'scheduled' | 'enrichment';
}
