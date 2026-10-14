/**
 * Local stand-in for the SQS event source mapping: long-polls the LocalStack ingest queue, invokes the
 * Lambda handler with an SQSEvent and deletes the messages that were processed successfully.
 *   pnpm --filter @portfolio/ingest dev
 */
import { DeleteMessageBatchCommand, GetQueueUrlCommand, ReceiveMessageCommand, SQSClient, type Message } from '@aws-sdk/client-sqs';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { drain, retryAttempts, sequentially } from './async.js';

const LOCAL_ENV: Record<string, string> = {
  TABLE_NAME: 'portfolio-tracker-local',
  EVENT_BUS_NAME: 'portfolio-tracker-local',
  IMPORT_BUCKET: 'portfolio-tracker-imports-local',
  INGEST_QUEUE_NAME: 'portfolio-tracker-ingest-local',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_REGION: 'eu-west-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
};
for (const [k, v] of Object.entries(LOCAL_ENV)) process.env[k] ??= v;

const { handler } = await import('./index.js');
const sqs = new SQSClient({ region: process.env.AWS_REGION, endpoint: process.env.AWS_ENDPOINT_URL });
const queueName = process.env.INGEST_QUEUE_NAME!;

export function toSqsRecord(m: Message, queueArn: string): SQSRecord {
  return {
    messageId: m.MessageId!,
    receiptHandle: m.ReceiptHandle!,
    body: m.Body ?? '',
    attributes: {
      ApproximateReceiveCount: m.Attributes?.ApproximateReceiveCount ?? '1',
      SentTimestamp: m.Attributes?.SentTimestamp ?? String(Date.now()),
      SenderId: m.Attributes?.SenderId ?? 'local',
      ApproximateFirstReceiveTimestamp: m.Attributes?.ApproximateFirstReceiveTimestamp ?? String(Date.now()),
    },
    messageAttributes: {},
    md5OfBody: m.MD5OfBody ?? '',
    eventSource: 'aws:sqs',
    eventSourceARN: queueArn,
    awsRegion: process.env.AWS_REGION!,
  };
}

let running = true;
process.on('SIGINT', () => (running = false));
process.on('SIGTERM', () => (running = false));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Returns the queue URL, or undefined (after logging) while the queue is not available yet. */
async function tryResolveQueueUrl(): Promise<string | undefined> {
  try {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    return QueueUrl;
  } catch (err) {
    console.error(`[ingest] queue '${queueName}' not available (${(err as Error).name}). Is LocalStack running? (docker compose up -d) Retrying in 5s…`);
    return undefined;
  }
}

async function resolveQueueUrl(): Promise<string> {
  for await (const url of retryAttempts(tryResolveQueueUrl, { delayMs: () => 5000, sleep })) {
    if (url) return url;
  }
  throw new Error('unreachable: queue URL retries are unbounded');
}

const queueUrl = await resolveQueueUrl();
const queueArn = `arn:aws:sqs:${process.env.AWS_REGION}:000000000000:${queueName}`;
console.log(`[ingest] polling ${queueUrl}`);

async function onPollError(err: unknown): Promise<void> {
  console.error('[ingest] poll error', err);
  await sleep(2000);
}

async function receiveBatch(): Promise<Message[]> {
  try {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 60, MessageSystemAttributeNames: ['All'] }),
    );
    return Messages;
  } catch (err) {
    await onPollError(err);
    return [];
  }
}

/** Long-polls until a stop signal arrives; yields each received (possibly empty) batch, fetching the next only once the consumer is done with it. */
async function* pollBatches(): AsyncGenerator<Message[], void, undefined> {
  while (running) yield receiveBatch();
}

async function handleBatch(messages: Message[]): Promise<void> {
  if (messages.length === 0) return;
  try {
    const event: SQSEvent = { Records: messages.map((m) => toSqsRecord(m, queueArn)) };
    const { batchItemFailures } = await handler(event, { awsRequestId: crypto.randomUUID() });
    const failed = new Set(batchItemFailures.map((f) => f.itemIdentifier));
    const done = messages.filter((m) => !failed.has(m.MessageId!));
    if (done.length) {
      await sqs.send(
        new DeleteMessageBatchCommand({ QueueUrl: queueUrl, Entries: done.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })) }),
      );
    }
    const retryNote = failed.size ? `, ${failed.size} left for retry` : '';
    console.log(`[ingest] processed ${done.length}/${messages.length} message(s)${retryNote}`);
  } catch (err) {
    await onPollError(err);
  }
}

await drain(sequentially(pollBatches(), handleBatch));
