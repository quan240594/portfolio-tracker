/**
 * Trading 212 sync contract shared by services/broker-sync, services/api and the web app.
 *
 * Personal use only: Trading 212's API terms allow access to the account holder's own account, so this is a
 * single-owner sync. Each user stores exactly one credential set (Secrets Manager) which is only ever readable by
 * the sync Lambda; the API accepts it on PUT /brokers/trading212 and never returns it.
 *
 * DynamoDB (single table):
 * | Entity           | PK              | SK                                 | entityType   |
 * |------------------|-----------------|------------------------------------|--------------|
 * | Broker sync state| USER#{userId}   | BROKER#trading212#{portfolioId}    | BROKER_STATE |
 */
import { z } from 'zod';
import { portfolioIdSchema } from './schemas.js';

export * from './broker-fx.js';
export * from './broker-symbols.js';
export * from './broker-csv.js';

export const BROKER_ID = 'trading212';
export const BROKER_ENTITY = 'BROKER_STATE';
export const BROKER_STATE_PREFIX = `BROKER#${BROKER_ID}#`;
/** Id prefix of every transaction written by the sync (`t212-{orderId}-{fillId}`, `t212-div-{reference}`). */
export const T212_TRANSACTION_ID_PREFIX = 't212-';
/** `importId` stored on synced transactions. */
export const T212_IMPORT_ID = 'trading212';
/** Detail source of the TransactionsChanged events emitted by the sync. */
export const BROKER_EVENT_SOURCE = 'portfolio.broker';

export const brokerKeys = {
  state: (userId: string, portfolioId: string) => ({
    PK: `USER#${userId}`,
    SK: `${BROKER_STATE_PREFIX}${portfolioId}`,
  }),
  statePrefix: BROKER_STATE_PREFIX,
  /** Outcome of the last Trading 212 quote refresh of a user (one item per user: the account's positions are portfolio independent). */
  quoteStatus: (userId: string) => ({ PK: `USER#${userId}`, SK: 'QUOTESYNC#trading212' }),
} as const;

export const T212_QUOTE_STATUS_ENTITY = 'T212_QUOTE_STATUS';
/** `source` of the quotes the Trading 212 quote refresh stores. */
export const T212_QUOTE_SOURCE = 't212';

export const T212_ENVIRONMENTS = ['live', 'demo'] as const;
export type T212Environment = (typeof T212_ENVIRONMENTS)[number];

export const T212_BASE_URLS: Readonly<Record<T212Environment, string>> = {
  live: 'https://live.trading212.com',
  demo: 'https://demo.trading212.com',
};

export interface Trading212Credentials {
  apiKey: string;
  apiSecret: string;
  environment: T212Environment;
}

/** Secrets Manager path of a user's credentials, e.g. `/portfolio-tracker/dev/broker/trading212/{userId}`. */
export const T212_SECRET_PREFIX = (env: string): string => `/portfolio-tracker/${env}/broker/trading212`;
/** Strips trailing slashes in linear time (a `/\/+$/` regex backtracks quadratically on long slash runs). */
export function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

const SECRET_USER_ID = /^[A-Za-z0-9_.@-]{1,128}$/;
export function t212SecretName(prefix: string, userId: string): string {
  if (!SECRET_USER_ID.test(userId)) throw new Error('User id cannot be used in a secret name');
  return `${trimTrailingSlashes(prefix)}/${userId}`;
}

const credentialText = (max: number) => z.string().trim().min(1).max(max);
export const trading212CredentialsSchema = z.object({
  apiKey: credentialText(200),
  apiSecret: credentialText(500),
  environment: z.enum(T212_ENVIRONMENTS).default('live'),
});

/** PUT /brokers/trading212 */
export const connectBrokerSchema = trading212CredentialsSchema.extend({ portfolioId: portfolioIdSchema });
export type ConnectBrokerRequest = z.infer<typeof connectBrokerSchema>;
/** GET /brokers/trading212?portfolioId=, POST /brokers/trading212/sync */
export const brokerScopeSchema = z.object({ portfolioId: portfolioIdSchema });

/** Payload of the sync Lambda: the daily schedule sends `{all:true}`, the API sends one user + portfolio. */
export const brokerSyncEventSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ userId: z.string().min(1), portfolioId: portfolioIdSchema, full: z.boolean().optional() }),
]);
export type BrokerSyncEvent = z.infer<typeof brokerSyncEventSchema>;

export const BROKER_SYNC_STATUSES = ['CONNECTED', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export type BrokerSyncStatus = (typeof BROKER_SYNC_STATUSES)[number];

export interface CashMovementCounts {
  deposits: number;
  withdrawals: number;
  fees: number;
  interest: number;
  other: number;
}

export interface BrokerSyncCounts {
  /** Filled orders fetched from Trading 212 in this run. */
  orders: number;
  dividends: number;
  /** Transactions created or changed in this run. */
  written: number;
  /** Items skipped (unmapped instruments, unsupported fill types, ...). */
  skipped: number;
  cashMovements: CashMovementCounts;
}

export interface UnmappedInstrument {
  ticker: string;
  isin?: string;
  name?: string;
  currency?: string;
  /** UnmappedReason, or a skip reason such as `UNSUPPORTED_FILL_STOCK_SPLIT`. */
  reason: string;
  count: number;
}

/** Max entries kept in the state item's lists. */
export const MAX_STATE_LIST = 50;

export interface BrokerSyncState {
  userId: string;
  portfolioId: string;
  broker: typeof BROKER_ID;
  environment: T212Environment;
  status: BrokerSyncStatus;
  /** Account currency reported by Trading 212. */
  accountCurrency?: string;
  connectedAt: string;
  updatedAt: string;
  /** Set when a run starts; a RUNNING state older than the stale-lock window may be taken over. */
  runStartedAt?: string;
  /** Token of the run that holds the lock: a redelivered start step of that run may take the lock again (see `beginRun`). */
  runId?: string;
  lastSyncAt?: string;
  lastSuccessAt?: string;
  /** Incremental sync watermarks (ISO timestamps of the newest processed item per source). */
  cursors?: { orders?: string; dividends?: string; cash?: string };
  counts?: BrokerSyncCounts;
  unmapped?: UnmappedInstrument[];
  warnings?: string[];
  lastError?: string;
}

export const T212_QUOTE_STATES = ['OK', 'AUTH_REJECTED', 'RATE_LIMITED', 'ERROR', 'NO_CREDENTIALS'] as const;
export type T212QuoteState = (typeof T212_QUOTE_STATES)[number];

/** Outcome of the last Trading 212 quote refresh of a user: what `GET /prices/status` reports and what drives the back-off. */
export interface T212QuoteStatus {
  userId: string;
  state: T212QuoteState;
  /** The last time the refresh went to Trading 212 (or found no credentials). */
  lastAttemptAt: string;
  lastSuccessAt?: string;
  /** Consecutive failed attempts; drives the back-off. */
  failures: number;
  /** Scheduled runs wait until this time after a failure. */
  nextAttemptAt?: string;
  /** Safe text (never credentials or response bodies). */
  lastError?: string;
  /** Quotes written by the last successful run. */
  quoted?: number;
  /** Positions of the last successful run that got no quote: unmapped instrument, no price, or a newer stored quote. */
  skipped?: number;
  /** Tickers that needed the exchange metadata to be mapped, with their symbol: the metadata is loaded once, not per run. */
  tickerSymbols?: Record<string, string>;
  /** Last time the (rate-limited, large) exchange metadata was requested. */
  metadataTriedAt?: string;
  /** When the first end-of-day row was written from the quotes (the one-time seed after the feature appeared). */
  eodSeededAt?: string;
  /** The calendar day (Amsterdam) whose close-slot rows were written: the close slot writes once a day. */
  eodClosedDay?: string;
}

/** GET /brokers/trading212 — never contains credentials. */
export interface BrokerStatusResponse {
  broker: typeof BROKER_ID;
  portfolioId: string;
  connected: boolean;
  environment?: T212Environment;
  status?: BrokerSyncStatus;
  accountCurrency?: string;
  connectedAt?: string;
  lastSyncAt?: string;
  lastSuccessAt?: string;
  counts?: BrokerSyncCounts;
  unmapped?: UnmappedInstrument[];
  warnings?: string[];
  lastError?: string;
}

export function toBrokerStatus(portfolioId: string, state: BrokerSyncState | null | undefined): BrokerStatusResponse {
  if (!state) return { broker: BROKER_ID, portfolioId, connected: false };
  const { userId: _u, cursors: _c, runStartedAt: _r, runId: _i, updatedAt: _t, portfolioId: _p, broker: _b, ...rest } = state;
  return { broker: BROKER_ID, portfolioId, connected: true, ...rest };
}

export type ConnectBrokerResponse = BrokerStatusResponse;
/** POST /brokers/trading212/sync -> 202 */
export interface SyncBrokerResponse {
  accepted: true;
}
