import type { EventPublisher, FileStore } from '@portfolio/platform';
import type { BrokerDeps } from './broker-deps.js';
import type { Config } from './config.js';
import type { ManagementRepository } from './management-repository.js';
import type { NotifyDeps } from './notifications/deps.js';
import type { Repository } from './repository.js';

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
