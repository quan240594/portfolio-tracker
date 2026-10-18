import { JOBS, type JobQueue } from './job.js';
import type { TransactionsChangedDetail } from '@portfolio/shared';

/**
 * Domain events the backend emits after a write. Failures are the caller's to handle (the API logs and moves on).
 * Delivery is at-least-once: consumers are idempotent.
 *
 * Implementations: EventBridge (`@portfolio/aws`), `QueueEventPublisher` (any `JobQueue`), `RecordingEventPublisher`.
 */
export interface EventPublisher {
  /** Transactions were created, deleted or imported; consumers enrich the newly tracked symbols. */
  transactionsChanged(detail: TransactionsChangedDetail): Promise<void>;
}

/** Publishes through a JobQueue: `transactionsChanged` becomes an `enrichTransactions` job. */
export class QueueEventPublisher implements EventPublisher {
  constructor(private readonly queue: JobQueue) {}

  transactionsChanged(detail: TransactionsChangedDetail): Promise<void> {
    return this.queue.enqueue({ job: JOBS.enrichTransactions, payload: detail });
  }
}

/** Test double: remembers what was published. */
export class RecordingEventPublisher implements EventPublisher {
  readonly published: TransactionsChangedDetail[] = [];

  transactionsChanged(detail: TransactionsChangedDetail): Promise<void> {
    this.published.push(detail);
    return Promise.resolve();
  }
}
