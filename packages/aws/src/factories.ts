import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { JobName } from '@portfolio/platform';
import { awsClientConfig, createDocClient, type AwsConnection } from './clients.js';
import { DynamoItemStore, type DynamoItemStoreOptions } from './dynamo-item-store.js';
import { EventBridgeEventPublisher } from './eventbridge-event-publisher.js';
import { LambdaJobQueue } from './lambda-job-queue.js';
import { createPresignS3Client, S3FileStore } from './s3-file-store.js';
import { SecretsManagerSecretStore } from './secrets-manager-secret-store.js';

/**
 * Composition helpers: the services build their AWS adapters through these, so no service imports the AWS SDK.
 * `connection` carries the region and the LocalStack endpoint override.
 */
export const createDynamoItemStore = (connection: AwsConnection, tableName: string, options?: DynamoItemStoreOptions): DynamoItemStore =>
  new DynamoItemStore(createDocClient(connection), tableName, options);

export const createEventBridgePublisher = (connection: AwsConnection, eventBusName: string, source: string): EventBridgeEventPublisher =>
  new EventBridgeEventPublisher(new EventBridgeClient(awsClientConfig(connection)), eventBusName, source);

export const createSecretStore = (connection: AwsConnection, description?: string): SecretsManagerSecretStore =>
  new SecretsManagerSecretStore(new SecretsManagerClient(awsClientConfig(connection)), description);

export const createLambdaJobQueue = (connection: AwsConnection, functions: Partial<Record<JobName, string>>): LambdaJobQueue =>
  new LambdaJobQueue(new LambdaClient(awsClientConfig(connection)), functions);

export const createS3FileStore = (connection: AwsConnection, bucket: string): S3FileStore =>
  new S3FileStore(createPresignS3Client(awsClientConfig(connection)), bucket);
