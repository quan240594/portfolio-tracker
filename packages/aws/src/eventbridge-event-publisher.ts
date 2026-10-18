import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { EventPublisher } from '@portfolio/platform';
import { DETAIL_TYPES, type TransactionsChangedDetail } from '@portfolio/shared';

/**
 * EventPublisher on an EventBridge bus. `source` identifies the emitting service (`EVENT_SOURCES.api`, `.ingest`,
 * `BROKER_EVENT_SOURCE`); the bus rules (infra/terraform/events.tf) route TransactionsChanged to the enrich queue.
 */
export class EventBridgeEventPublisher implements EventPublisher {
  constructor(
    private readonly client: Pick<EventBridgeClient, 'send'>,
    private readonly eventBusName: string,
    private readonly source: string,
  ) {}

  async transactionsChanged(detail: TransactionsChangedDetail): Promise<void> {
    const res = await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.eventBusName,
            Source: this.source,
            DetailType: DETAIL_TYPES.transactionsChanged,
            Detail: JSON.stringify(detail),
          },
        ],
      }),
    );
    if (res.FailedEntryCount) {
      const entry = res.Entries?.find((e) => e.ErrorCode);
      throw new Error(`PutEvents failed: ${entry?.ErrorCode ?? 'unknown'} ${entry?.ErrorMessage ?? ''}`.trim());
    }
  }
}
