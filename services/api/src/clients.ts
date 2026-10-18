import { createDynamoItemStore, createEventBridgePublisher, createLambdaJobQueue, createS3FileStore } from '@portfolio/aws';
import { JOBS, MemoryJobQueue, logger, type JobQueue } from '@portfolio/platform';
import { ItemBrokerStore, brokerSyncJob } from '@portfolio/broker-sync';
import {
  createAwsDeps as createSyncDeps,
  createCredentialStore,
  createItemStore,
  loadConfig as loadBrokerConfig,
} from '@portfolio/broker-sync/aws';
import { EVENT_SOURCES } from '@portfolio/shared';
import { verifyWithTrading212, type BrokerDeps } from './broker-deps.js';
import type { Config } from './config.js';
import type { Deps } from './deps.js';
import { ItemManagementRepository } from './management-repository.js';
import { ItemRepository } from './repository.js';

/** The AWS adapters of the API: DynamoDB, EventBridge, S3 presigned uploads, Secrets Manager + Lambda for the sync. */
export function createAwsDeps(config: Config): Deps {
  const connection = { region: config.region, endpointUrl: config.endpointUrl };
  // Interactive requests: fewer, shorter retries than the background jobs, and no jitter.
  const items = createDynamoItemStore(connection, config.tableName, { maxAttempts: 9, maxDelayMs: 2000, jitter: false });
  return {
    repo: new ItemRepository(items),
    mgmt: new ItemManagementRepository(items),
    events: createEventBridgePublisher(connection, config.eventBusName, EVENT_SOURCES.api),
    files: createS3FileStore(connection, config.importBucket),
    broker: createBrokerDeps(config),
    config,
    now: () => new Date(),
    uuid: () => crypto.randomUUID(),
  };
}

/** Table and endpoint come from the API config; the secret prefix and sync function from the BROKER_* variables. */
export function createBrokerDeps(api: Pick<Config, 'tableName' | 'region' | 'endpointUrl'>): BrokerDeps {
  const config = { ...loadBrokerConfig(), ...api };
  return {
    store: new ItemBrokerStore(createItemStore(config)),
    credentials: createCredentialStore(config),
    verify: verifyWithTrading212,
    jobs: config.syncFunctionName ? createLambdaJobQueue(config, { [JOBS.syncBroker]: config.syncFunctionName }) : inProcessJobs(),
  };
}

/** Local development (no sync Lambda): runs the sync inside the API process. Failures land in the state item. */
export function inProcessJobs(): JobQueue {
  const sync = brokerSyncJob(() => createSyncDeps(loadBrokerConfig()));
  return new MemoryJobQueue(
    { [JOBS.syncBroker]: sync },
    { runInBackground: true, maxAttempts: 1, onError: (err) => logger.error('Local sync failed', { error: (err as Error).name }) },
  );
}
