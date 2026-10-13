import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Deps } from './deps.js';
import { EventBridgePublisher } from './events.js';
import { createPresignS3Client, S3UploadUrlSigner } from './presigner.js';
import { DynamoRepository } from './repository.js';

export function createAwsDeps(config: Config): Deps {
  const common = { region: config.region, ...(config.endpointUrl ? { endpoint: config.endpointUrl } : {}) };
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient(common), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = createPresignS3Client(common);
  return {
    repo: new DynamoRepository(doc, config.tableName),
    events: new EventBridgePublisher(new EventBridgeClient(common), config.eventBusName),
    signer: new S3UploadUrlSigner(s3, config.importBucket),
    config,
    now: () => new Date(),
    uuid: () => randomUUID(),
  };
}
