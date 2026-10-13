import type { Config } from './config.js';
import type { EventPublisher } from './events.js';
import type { UploadUrlSigner } from './presigner.js';
import type { Repository } from './repository.js';

export interface Deps {
  repo: Repository;
  events: EventPublisher;
  signer: UploadUrlSigner;
  config: Pick<Config, 'baseCurrency' | 'demoUserId' | 'corsAllowedOrigin'>;
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
