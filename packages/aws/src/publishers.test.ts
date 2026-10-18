import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { EventBridgeEventPublisher } from './eventbridge-event-publisher.js';
import { LambdaJobQueue } from './lambda-job-queue.js';

const eb = mockClient(EventBridgeClient);
const lambda = mockClient(LambdaClient);
beforeEach(() => {
  eb.reset();
  lambda.reset();
});

describe('EventBridgeEventPublisher', () => {
  const publisher = new EventBridgeEventPublisher(new EventBridgeClient({ region: 'eu-west-1' }), 'bus', 'portfolio.api');
  const detail = { userId: 'u', portfolioId: 'p1', symbols: ['A'], reason: 'CREATED' } as const;
  const change = () => publisher.transactionsChanged({ ...detail, symbols: [...detail.symbols] });

  it('publishes TransactionsChanged from its source onto the bus', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: '1' }] });
    await change();
    const entry = eb.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!;
    expect(entry).toMatchObject({ EventBusName: 'bus', Source: 'portfolio.api', DetailType: 'TransactionsChanged' });
    expect(JSON.parse(entry.Detail!)).toEqual(detail);
  });

  it('throws with the error code and message of a failed entry', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'slow down' }] });
    await expect(change()).rejects.toThrow('PutEvents failed: ThrottlingException slow down');
  });

  it('reports an unknown failure when no entry carries an error code', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 1 });
    await expect(change()).rejects.toThrow(/^PutEvents failed: unknown$/);
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 1, Entries: [{ EventId: 'ok' }, { ErrorCode: 'InternalFailure' }] });
    await expect(change()).rejects.toThrow(/^PutEvents failed: InternalFailure$/);
  });

  it('propagates transport errors', async () => {
    eb.on(PutEventsCommand).rejects(new Error('network down'));
    await expect(change()).rejects.toThrow('network down');
  });
});

describe('LambdaJobQueue', () => {
  const queue = new LambdaJobQueue(new LambdaClient({ region: 'eu-west-1' }), { syncBroker: 'sync-fn' });

  it('invokes the function of the job asynchronously with the bare payload', async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
    await queue.enqueue({ job: 'syncBroker', payload: { userId: 'u', portfolioId: 'p' } });
    const input = lambda.commandCalls(InvokeCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ FunctionName: 'sync-fn', InvocationType: 'Event' });
    expect(JSON.parse(String(input.Payload))).toEqual({ userId: 'u', portfolioId: 'p' });
  });

  it('fails for a job that has no function', async () => {
    await expect(queue.enqueue({ job: 'refreshPrices', payload: { trigger: 'scheduled' } })).rejects.toThrow('No Lambda function is configured for job "refreshPrices"');
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
  });
});
