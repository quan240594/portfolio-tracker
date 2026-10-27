import type { EventPublisher, FileStore, ItemStore } from '@portfolio/platform';
import type { EarningsBackfillResponse, EarningsRefreshResponse, EarningsStatusResponse } from '@portfolio/shared';
import type { BrokerDeps } from './broker-deps.js';
import type { Config } from './config.js';
import type { InflationFetch } from './inflation/source.js';
import type { ManagementRepository } from './management-repository.js';
import type { NotifyDeps } from './notifications/deps.js';
import type { Repository } from './repository.js';

/** The earnings summaries feature of a deployment that has it (the Cloudflare app); the AWS stack has none and its routes answer `available: false`. */
export interface EarningsDeps {
  /** Whether the feature is configured, the last checks of the symbols and the Workers AI neurons used today. */
  status(symbols: readonly { symbol: string; eligible: boolean }[]): Promise<EarningsStatusResponse>;
  /** Queues a re-check of one symbol; refuses (without queuing) when it was asked for less than an hour ago. */
  refresh(symbol: string, eligible: boolean): Promise<EarningsRefreshResponse>;
  /** "Fetch all now": re-arms the backfill of the last quarters of every holding; refuses (without queuing) when it was asked for less than an hour ago. */
  backfill(): Promise<EarningsBackfillResponse>;
}

/**
 * The price service's use of the owner's price history symbol (the Cloudflare app); the AWS stack has none, it only stores and returns the
 * field. `changed` is awaited after the classification was stored and must not throw for a failure that leaves the stored value intact.
 */
export interface HistorySymbolDeps {
  /** `historySymbol` is the new value (`null`: cleared) of the holding `symbol`. */
  changed(symbol: string, historySymbol: string | null): Promise<void>;
}

/** The inflation series feature (ECB): where the monthly copy is cached and the outbound `fetch` (the only way out; it is counted against the platform's budget). */
export interface InflationDeps {
  items: ItemStore;
  fetch: InflationFetch;
}

/** Everything the handlers need from the platform: repositories, events, files, the clock. Built by the adapter. */
export interface Deps {
  repo: Repository;
  mgmt: ManagementRepository;
  events: EventPublisher;
  /** Where CSV uploads go; the ingestion job reads them from there. */
  files: FileStore;
  /** Trading 212 sync; routes answer 503 when absent. */
  broker?: BrokerDeps;
  /** Dividend push notifications (settings, devices, test push); routes answer `available: false` when absent. */
  notify?: NotifyDeps;
  /** Earnings summaries (status and refresh); routes answer `available: false` when absent. */
  earnings?: EarningsDeps;
  /** The price history symbol override reaching the price jobs; absent = the field is only stored. */
  historySymbols?: HistorySymbolDeps;
  /** ECB inflation series (`GET /inflation`); the route answers 503 when absent. */
  inflation?: InflationDeps;
  config: Pick<Config, 'baseCurrency' | 'authMode' | 'demoUserId' | 'corsAllowedOrigin'>;
  now: () => Date;
  uuid: () => string;
}

export interface RouteContext {
  deps: Deps;
  userId: string;
  pathParams: Record<string, string>;
  query: Record<string, string | undefined>;
  /** The request body as text. */
  body?: string;
}
