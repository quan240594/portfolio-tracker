import {
  createDynamoItemStore,
  createEventBridgePublisher,
  createSecretStore,
  type AwsConnection,
} from '@portfolio/aws';
import { BROKER_EVENT_SOURCE } from '@portfolio/shared';
import type { Config } from './config.js';
import { SecretCredentialStore } from './credentials.js';
import { ItemBrokerStore } from './store.js';
import type { SyncDeps } from './sync.js';
import { Trading212Client } from './t212/client.js';

const connectionOf = ({ region, endpointUrl }: Pick<Config, 'region' | 'endpointUrl'>): AwsConnection => ({ region, endpointUrl });

/** DynamoDB table access of the sync (and of the API's broker endpoints). */
export const createItemStore = (config: Pick<Config, 'region' | 'endpointUrl' | 'tableName'>) =>
  createDynamoItemStore(connectionOf(config), config.tableName);

/** Credentials in Secrets Manager, one secret per user under `config.secretPrefix`. */
export function createCredentialStore(config: Pick<Config, 'region' | 'endpointUrl' | 'secretPrefix'>): SecretCredentialStore {
  return new SecretCredentialStore(createSecretStore(connectionOf(config), 'Trading 212 read-only API credentials'), config.secretPrefix);
}

/** Deps of the deployed Lambda: credentials from Secrets Manager. */
export function createAwsDeps(config: Config): SyncDeps {
  return {
    store: new ItemBrokerStore(createItemStore(config)),
    events: createEventBridgePublisher(connectionOf(config), config.eventBusName, BROKER_EVENT_SOURCE),
    credentials: createCredentialStore(config),
    createApi: (credentials) => new Trading212Client({ credentials }),
    symbolOverrides: config.symbolOverrides,
    now: () => new Date(),
  };
}
