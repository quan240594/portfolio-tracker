import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import type { JobMessage, JobName, JobQueue } from '@portfolio/platform';

/**
 * JobQueue that starts a job by invoking its Lambda function asynchronously (`InvocationType: Event`); Lambda retries
 * a failed asynchronous invocation, which is the at-least-once delivery. The function receives the bare payload and
 * runs the whole job inside the invocation (`runToCompletion`), so a `delayMs` is not needed and not honoured.
 */
export class LambdaJobQueue implements JobQueue {
  constructor(
    private readonly client: Pick<LambdaClient, 'send'>,
    private readonly functions: Partial<Record<JobName, string>>,
  ) {}

  async enqueue<N extends JobName>(message: JobMessage<N>): Promise<void> {
    const functionName = this.functions[message.job];
    if (!functionName) throw new Error(`No Lambda function is configured for job "${message.job}"`);
    await this.client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: 'Event', Payload: JSON.stringify(message.payload) }));
  }
}
