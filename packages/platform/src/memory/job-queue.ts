import type { JobHandler, JobMessage, JobName, JobPayloads, JobQueue, JobRegistry } from '../job.js';

export interface MemoryJobQueueOptions {
  /** How often a failing step is delivered before the message is dead-lettered (at-least-once). Default 3. */
  maxAttempts?: number;
  /** Start processing as soon as a message arrives (local development); otherwise call `drain()`. */
  runInBackground?: boolean;
  /** Receives the error of a step that failed. */
  onError?: (error: unknown, message: JobMessage) => void;
}

interface Pending {
  message: JobMessage;
  cursor?: string;
  attempt: number;
}

export interface DeadLetter {
  message: JobMessage;
  error: unknown;
}

/**
 * In-memory JobQueue: the reference implementation of the port, the test double and the local-development queue
 * (jobs run inside the process). It behaves like a budgeted adapter: a step that returns `{ done: false, next }` is
 * re-queued with the cursor, a failing step is redelivered with the same cursor up to `maxAttempts` times.
 */
export class MemoryJobQueue implements JobQueue {
  /** Every message ever enqueued, in order (continuations excluded). */
  readonly enqueued: JobMessage[] = [];
  /** Results of the finished jobs, in completion order. */
  readonly results: { job: JobName; result: unknown }[] = [];
  readonly deadLetters: DeadLetter[] = [];
  private readonly pending: Pending[] = [];
  private draining: Promise<void> | undefined;

  constructor(
    private readonly handlers: JobRegistry = {},
    private readonly options: MemoryJobQueueOptions = {},
  ) {}

  register<N extends JobName>(job: N, handler: JobHandler<JobPayloads[N]>): this {
    (this.handlers as Record<string, unknown>)[job] = handler;
    return this;
  }

  enqueue<N extends JobName>(message: JobMessage<N>): Promise<void> {
    this.enqueued.push(message);
    this.pending.push({ message, attempt: 1 });
    if (this.options.runInBackground) void this.drain();
    return Promise.resolve();
  }

  /** Processes the queue (including continuations and redeliveries) until it is empty. */
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    // The run starts in a microtask, so `draining` is set before its first (synchronous) look at the queue.
    this.draining = Promise.resolve().then(() => this.pump());
    return this.draining;
  }

  /** Delivers the next message; the run ends (and a later `enqueue` starts a new one) at the first empty look. */
  private pump(): Promise<void> {
    const next = this.pending.shift();
    if (!next) {
      this.draining = undefined;
      return Promise.resolve();
    }
    return this.deliver(next).then(() => this.pump());
  }

  private async deliver({ message, cursor, attempt }: Pending): Promise<void> {
    const handler = this.handlers[message.job] as JobHandler<JobPayloads[JobName]> | undefined;
    try {
      if (!handler) throw new Error(`No handler registered for job "${message.job}"`);
      const step = await handler({ payload: message.payload, cursor });
      if (step.done) this.results.push({ job: message.job, result: step.result });
      else this.pending.push({ message, cursor: step.next, attempt: 1 });
    } catch (error) {
      const { maxAttempts = 3 } = this.options;
      if (attempt < maxAttempts) this.pending.push({ message, cursor, attempt: attempt + 1 });
      else {
        this.deadLetters.push({ message, error });
        this.options.onError?.(error, message);
      }
    }
  }
}
