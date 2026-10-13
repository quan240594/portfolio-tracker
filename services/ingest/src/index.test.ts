import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { eventBridgeBody, sqsEvent } from './testing/fakes.js';

const createAwsDeps = vi.hoisted(() => vi.fn());
vi.mock('./clients.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./clients.js')>();
  createAwsDeps.mockImplementation(actual.createAwsDeps);
  return { createAwsDeps };
});

const ddbMock = mockClient(DynamoDBDocumentClient);

afterEach(() => vi.unstubAllEnvs());

describe('Lambda entry point', () => {
  it('builds AWS deps from the environment once and reuses them across invocations', async () => {
    vi.stubEnv('TABLE_NAME', 'prod-table');
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    ddbMock.on(GetCommand).resolves({});
    const { handler } = await import('./index.js');

    const first = await handler(sqsEvent(eventBridgeBody('b', 'imports/u/i.csv')), { awsRequestId: 'r1' });
    const second = await handler(sqsEvent(eventBridgeBody('b', 'imports/u/j.csv')));

    expect(first).toEqual({ batchItemFailures: [] });
    expect(second).toEqual({ batchItemFailures: [] });
    expect(createAwsDeps).toHaveBeenCalledTimes(1);
    expect(createAwsDeps.mock.calls[0]![0]).toMatchObject({ tableName: 'prod-table', region: 'eu-west-1' });
    expect(ddbMock.commandCalls(GetCommand).map((c) => [c.args[0].input.TableName, c.args[0].input.Key])).toEqual([
      ['prod-table', { PK: 'USER#u', SK: 'IMPORT#i' }],
      ['prod-table', { PK: 'USER#u', SK: 'IMPORT#j' }],
    ]);
  });
});
