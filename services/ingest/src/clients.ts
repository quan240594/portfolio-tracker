import { createDynamoItemStore, createEventBridgePublisher, createS3FileStore } from '@portfolio/aws';
import { EVENT_SOURCES } from '@portfolio/shared';
import type { Config } from './config.js';
import type { IngestDeps } from './processor.js';
import { ItemIngestStore } from './store.js';

export function createAwsDeps(config: Config): IngestDeps {
  const connection = { region: config.region, endpointUrl: config.endpointUrl };
  return {
    store: new ItemIngestStore(createDynamoItemStore(connection, config.tableName)),
    files: createS3FileStore(connection, config.importBucket),
    events: createEventBridgePublisher(connection, config.eventBusName, EVENT_SOURCES.ingest),
    now: () => new Date(),
  };
}
