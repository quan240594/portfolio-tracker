import type { BrokerDeps } from './broker-deps.js';
import type { Config } from './config.js';
import type { EventPublisher } from './events.js';
import type { UploadUrlSigner } from './presigner.js';
import type { ManagementRepository } from './management-repository.js';
import type { Repository } from './repository.js';

export interface Deps {
  repo: Repository;
  mgmt: ManagementRepository;
  events: EventPublisher;
  signer: UploadUrlSigner;
  /** Trading 212 sync; routes answer 503 when absent. */
  broker?: BrokerDeps;
  config: Pick<Config, 'baseCurrency' | 'authMode' | 'demoUserId' | 'corsAllowedOrigin'>;
  now: () => Date;
  uuid: () => string;
}

export interface RouteContext {
  deps: Deps;
  userId: string;
  pathParams: Record<string, string>;
  query: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}
