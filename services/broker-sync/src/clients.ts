import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Config } from './config.js';
import { SecretsManagerCredentialStore } from './credentials.js';
import { EventBridgePublisher } from './events.js';
import { DynamoBrokerStore } from './store.js';
import type { SyncDeps } from './sync.js';
import { Trading212Client } from './t212/client.js';

export function awsCommon(config: Config) {
  return { region: config.region, ...(config.endpointUrl ? { endpoint: config.endpointUrl } : {}) };
}

export function createDocClient(config: Config): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient(awsCommon(config)), { marshallOptions: { removeUndefinedValues: true } });
}

/** Deps of the deployed Lambda: credentials from Secrets Manager. */
export function createAwsDeps(config: Config): SyncDeps {
  const common = awsCommon(config);
  return {
    store: new DynamoBrokerStore(createDocClient(config), config.tableName),
    events: new EventBridgePublisher(new EventBridgeClient(common), config.eventBusName),
    credentials: new SecretsManagerCredentialStore(new SecretsManagerClient(common), config.secretPrefix),
    createApi: (credentials) => new Trading212Client({ credentials }),
    symbolOverrides: config.symbolOverrides,
    now: () => new Date(),
  };
}
