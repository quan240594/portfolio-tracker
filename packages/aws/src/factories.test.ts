import { describe, expect, it } from 'vitest';
import {
  DynamoItemStore,
  EventBridgeEventPublisher,
  LambdaJobQueue,
  S3FileStore,
  SecretsManagerSecretStore,
  createDynamoItemStore,
  createEventBridgePublisher,
  createLambdaJobQueue,
  createS3FileStore,
  createSecretStore,
} from './index.js';

const connection = { region: 'eu-west-1', endpointUrl: 'http://localhost:4566' };

describe('factories', () => {
  it('build every adapter for a connection', () => {
    expect(createDynamoItemStore(connection, 'tbl', { maxAttempts: 3 })).toBeInstanceOf(DynamoItemStore);
    expect(createDynamoItemStore({ region: 'eu-west-1' }, 'tbl')).toBeInstanceOf(DynamoItemStore);
    expect(createEventBridgePublisher(connection, 'bus', 'portfolio.api')).toBeInstanceOf(EventBridgeEventPublisher);
    expect(createSecretStore(connection, 'desc')).toBeInstanceOf(SecretsManagerSecretStore);
    expect(createLambdaJobQueue(connection, { syncBroker: 'fn' })).toBeInstanceOf(LambdaJobQueue);
    expect(createS3FileStore(connection, 'bucket')).toBeInstanceOf(S3FileStore);
  });
});
