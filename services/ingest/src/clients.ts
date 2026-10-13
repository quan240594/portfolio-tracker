import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Config } from './config.js';
import { EventBridgePublisher } from './events.js';
import { S3ObjectReader } from './objects.js';
import type { IngestDeps } from './processor.js';
import { DynamoIngestStore } from './store.js';

export function createAwsDeps(config: Config): IngestDeps {
  const common = { region: config.region, ...(config.endpointUrl ? { endpoint: config.endpointUrl } : {}) };
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient(common), { marshallOptions: { removeUndefinedValues: true } });
  return {
    store: new DynamoIngestStore(doc, config.tableName),
    reader: new S3ObjectReader(new S3Client({ ...common, forcePathStyle: Boolean(config.endpointUrl) })),
    events: new EventBridgePublisher(new EventBridgeClient(common), config.eventBusName),
    now: () => new Date(),
  };
}
