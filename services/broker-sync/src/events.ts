import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { BROKER_EVENT_SOURCE, DETAIL_TYPES, type TransactionsChangedDetail } from '@portfolio/shared';

export interface EventPublisher {
  transactionsChanged(detail: TransactionsChangedDetail): Promise<void>;
}

export class EventBridgePublisher implements EventPublisher {
  constructor(
    private readonly client: Pick<EventBridgeClient, 'send'>,
    private readonly eventBusName: string,
  ) {}

  async transactionsChanged(detail: TransactionsChangedDetail): Promise<void> {
    const res = await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.eventBusName,
            Source: BROKER_EVENT_SOURCE,
            DetailType: DETAIL_TYPES.transactionsChanged,
            Detail: JSON.stringify(detail),
          },
        ],
      }),
    );
    if (res.FailedEntryCount) {
      const entry = res.Entries?.find((e) => e.ErrorCode);
      throw new Error(`PutEvents failed: ${entry?.ErrorCode ?? 'unknown'}`);
    }
  }
}
