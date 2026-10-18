import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryFileStore, MemoryItemStore, RecordingEventPublisher } from '@portfolio/platform';
import { createAwsDeps } from './clients.js';
import type { Config } from './config.js';
import { ItemIngestStore } from './store.js';

const aws = vi.hoisted(() => ({
  createDynamoItemStore: vi.fn(),
  createEventBridgePublisher: vi.fn(),
  createS3FileStore: vi.fn(),
}));
vi.mock('@portfolio/aws', () => aws);

const base: Config = { tableName: 'tbl', eventBusName: 'bus', importBucket: 'bkt', region: 'eu-central-1' };

beforeEach(() => {
  aws.createDynamoItemStore.mockReset().mockImplementation(() => new MemoryItemStore());
  aws.createEventBridgePublisher.mockReset().mockImplementation(() => new RecordingEventPublisher());
  aws.createS3FileStore.mockReset().mockImplementation(() => new MemoryFileStore());
});

describe('createAwsDeps', () => {
  it('wires the AWS adapters to the configured table, bus, bucket and region', () => {
    const deps = createAwsDeps(base);
    expect(deps.store).toBeInstanceOf(ItemIngestStore);
    expect(deps.files).toBeInstanceOf(MemoryFileStore);
    const connection = { region: 'eu-central-1', endpointUrl: undefined };
    expect(aws.createDynamoItemStore).toHaveBeenCalledWith(connection, 'tbl');
    expect(aws.createS3FileStore).toHaveBeenCalledWith(connection, 'bkt');
    expect(aws.createEventBridgePublisher).toHaveBeenCalledWith(connection, 'bus', 'portfolio.ingest');
    expect(Math.abs(deps.now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it('points every client at a custom endpoint (LocalStack)', () => {
    createAwsDeps({ ...base, endpointUrl: 'http://localhost:4566' });
    const connection = { region: 'eu-central-1', endpointUrl: 'http://localhost:4566' };
    expect(aws.createDynamoItemStore).toHaveBeenCalledWith(connection, 'tbl');
    expect(aws.createS3FileStore).toHaveBeenCalledWith(connection, 'bkt');
    expect(aws.createEventBridgePublisher).toHaveBeenCalledWith(connection, 'bus', 'portfolio.ingest');
  });
});
