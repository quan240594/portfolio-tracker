import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { apiEvent } from './testing/fakes.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  vi.resetModules();
  vi.stubEnv('TABLE_NAME', 'prod-table');
  vi.stubEnv('CORS_ALLOWED_ORIGIN', 'https://portfolio.example');
  vi.stubEnv('AWS_REGION', 'eu-west-1');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('./clients.js');
});

describe('Lambda handler', () => {
  it('builds AWS deps from the environment and serves requests', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ PK: 'USER#demo', SK: 'TXN#2025-01-01#a', entityType: 'TRANSACTION', id: 'a', date: '2025-01-01', createdAt: 'x' }],
    });
    vi.stubEnv('AUTH_MODE', 'demo');
    const { handler } = await import('./index.js');
    const res = await handler(apiEvent('GET', '/transactions'), { awsRequestId: 'lambda-req' });
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['access-control-allow-origin']).toBe('https://portfolio.example');
    expect(JSON.parse(res.body!)).toEqual({ transactions: [{ id: 'a', date: '2025-01-01', createdAt: 'x' }] });
    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({
      TableName: 'prod-table',
      ExpressionAttributeValues: { ':pk': 'USER#demo' },
    });
  });

  it('creates the AWS clients once per container and reuses them across invocations', async () => {
    const actual = await vi.importActual<typeof import('./clients.js')>('./clients.js');
    const createAwsDeps = vi.fn(actual.createAwsDeps);
    vi.doMock('./clients.js', () => ({ createAwsDeps }));
    vi.stubEnv('AUTH_MODE', 'demo');
    const { handler } = await import('./index.js');
    expect((await handler(apiEvent('GET', '/health'))).statusCode).toBe(200);
    expect((await handler(apiEvent('GET', '/health'))).statusCode).toBe(200);
    expect(createAwsDeps).toHaveBeenCalledTimes(1);
    expect(createAwsDeps.mock.calls[0]![0]).toMatchObject({ tableName: 'prod-table', corsAllowedOrigin: 'https://portfolio.example' });
  });

  it('fails closed: without AUTH_MODE the Lambda requires the authorizer claims and never reads the demo user', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const { handler } = await import('./index.js');
    const res = await handler(apiEvent('GET', '/transactions'));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body!).error.code).toBe('UNAUTHENTICATED');
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);

    const authed = await handler(apiEvent('GET', '/transactions', { sub: 'user-1' }));
    expect(authed.statusCode).toBe(200);
    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({ ExpressionAttributeValues: { ':pk': 'USER#user-1' } });
  });
});
