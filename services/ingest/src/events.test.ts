import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { EventBridgePublisher } from './events.js';

const ebMock = mockClient(EventBridgeClient);
const publisher = new EventBridgePublisher(new EventBridgeClient({ region: 'eu-west-1' }), 'bus');
const detail = { userId: 'u', portfolioId: 'p1', symbols: ['AAPL'], reason: 'IMPORTED' as const, importId: 'i' };

beforeEach(() => ebMock.reset());

describe('EventBridgePublisher', () => {
  it('publishes a single TransactionsChanged entry to the configured bus', async () => {
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'e1' }] });
    await publisher.transactionsChanged(detail);
    expect(ebMock.commandCalls(PutEventsCommand)[0]!.args[0].input).toEqual({
      Entries: [{ EventBusName: 'bus', Source: 'portfolio.ingest', DetailType: 'TransactionsChanged', Detail: JSON.stringify(detail) }],
    });
  });

  it('succeeds when the response omits FailedEntryCount', async () => {
    ebMock.on(PutEventsCommand).resolves({});
    await expect(publisher.transactionsChanged(detail)).resolves.toBeUndefined();
  });

  it('throws with the failing entry code and message when FailedEntryCount > 0', async () => {
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'Rate exceeded' }] });
    await expect(publisher.transactionsChanged(detail)).rejects.toThrow(/^PutEvents failed: ThrottlingException Rate exceeded$/);
  });

  it('throws a generic error when the failed entry is not identified', async () => {
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 1 });
    await expect(publisher.transactionsChanged(detail)).rejects.toThrow(/^PutEvents failed: unknown$/);
    ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 1, Entries: [{ EventId: 'ok' }] });
    await expect(publisher.transactionsChanged(detail)).rejects.toThrow(/^PutEvents failed: unknown$/);
  });

  it('propagates client errors', async () => {
    ebMock.on(PutEventsCommand).rejects(new Error('network down'));
    await expect(publisher.transactionsChanged(detail)).rejects.toThrow('network down');
  });
});
