import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { BrokerError } from '@portfolio/broker-sync';
import { verifyWithTrading212 } from './broker-deps.js';
import { createBrokerDeps } from './clients.js';
import { loadConfig } from './config.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const lambdaMock = mockClient(LambdaClient);
const secretsMock = mockClient(SecretsManagerClient);

beforeEach(() => {
  ddbMock.reset();
  lambdaMock.reset();
  secretsMock.reset();
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('verifyWithTrading212', () => {
  it('returns the upper-cased account currency using a single quick attempt', async () => {
    const fetchFn = vi.fn((_url: string) => Promise.resolve(Response.json({ id: 1, currency: 'eur' })));
    vi.stubGlobal('fetch', fetchFn);
    await expect(verifyWithTrading212({ apiKey: 'k', apiSecret: 's', environment: 'demo' })).resolves.toEqual({ accountCurrency: 'EUR' });
    expect(fetchFn.mock.calls[0]![0]).toBe('https://demo.trading212.com/api/v0/equity/account/summary');
    vi.unstubAllGlobals();
  });

  it('rejects with T212_AUTH_REJECTED on 401 without retrying', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response('', { status: 401 })));
    vi.stubGlobal('fetch', fetchFn);
    await expect(verifyWithTrading212({ apiKey: 'k', apiSecret: 's', environment: 'live' })).rejects.toMatchObject({
      code: 'T212_AUTH_REJECTED',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('does not wait for rate limits', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 429 }))));
    await expect(verifyWithTrading212({ apiKey: 'k', apiSecret: 's', environment: 'live' })).rejects.toBeInstanceOf(BrokerError);
    vi.unstubAllGlobals();
  });
});

describe('createBrokerDeps', () => {
  it('uses the API table, the BROKER_* settings and invokes the sync Lambda when configured', async () => {
    vi.stubEnv('BROKER_SECRET_PREFIX', '/pt/dev/broker/trading212');
    vi.stubEnv('BROKER_SYNC_FUNCTION', 'sync-fn');
    const deps = createBrokerDeps(loadConfig({ TABLE_NAME: 'tbl', AWS_REGION: 'eu-central-1' }));

    ddbMock.on(GetCommand).resolves({});
    expect(await deps.store.getState('u', 'p')).toBeNull();
    expect(ddbMock.commandCalls(GetCommand)[0]!.args[0].input.TableName).toBe('tbl');

    secretsMock.on(PutSecretValueCommand).resolves({});
    await deps.credentials.put('u', { apiKey: 'k', apiSecret: 's', environment: 'live' });
    expect(secretsMock.commandCalls(PutSecretValueCommand)[0]!.args[0].input.SecretId).toBe('/pt/dev/broker/trading212/u');

    lambdaMock.on(InvokeCommand).resolves({});
    await deps.jobs.enqueue({ job: 'syncBroker', payload: { userId: 'u', portfolioId: 'p' } });
    const input = lambdaMock.commandCalls(InvokeCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ FunctionName: 'sync-fn', InvocationType: 'Event' });
    expect(JSON.parse(String(input.Payload))).toEqual({ userId: 'u', portfolioId: 'p' });
  });

  it('without a sync function runs the sync in-process and never throws into the request', async () => {
    const deps = createBrokerDeps(loadConfig({ TABLE_NAME: 'tbl', AWS_REGION: 'eu-west-1' }));
    // No state is stored, so the in-process run ends as a recorded NOT_CONNECTED failure.
    ddbMock.on(GetCommand).resolves({});
    await expect(deps.jobs.enqueue({ job: 'syncBroker', payload: { userId: 'u', portfolioId: 'p' } })).resolves.toBeUndefined();
    await vi.waitFor(() => expect(ddbMock.commandCalls(GetCommand).length).toBeGreaterThan(0));
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('logs (without details) when the in-process sync fails unexpectedly', async () => {
    const deps = createBrokerDeps(loadConfig({ TABLE_NAME: 'tbl', AWS_REGION: 'eu-west-1' }));
    ddbMock.on(GetCommand).rejects(new Error('ddb down'));
    await deps.jobs.enqueue({ job: 'syncBroker', payload: { userId: 'u', portfolioId: 'p' } });
    await vi.waitFor(() => expect(ddbMock.commandCalls(GetCommand).length).toBeGreaterThan(0));
  });
});
