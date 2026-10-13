/**
 * Local stand-in for the SQS event source mapping: long-polls the LocalStack ingest queue, invokes the
 * Lambda handler with an SQSEvent and deletes the messages that were processed successfully.
 *   pnpm --filter @portfolio/ingest dev
 */
import { DeleteMessageBatchCommand, GetQueueUrlCommand, ReceiveMessageCommand, SQSClient, type Message } from '@aws-sdk/client-sqs';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

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

async function resolveQueueUrl(): Promise<string> {
  for (;;) {
    try {
      const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
      return QueueUrl!;
    } catch (err) {
      console.error(`[ingest] queue '${queueName}' not available (${(err as Error).name}). Is LocalStack running? (docker compose up -d) Retrying in 5s…`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

const queueUrl = await resolveQueueUrl();
const queueArn = `arn:aws:sqs:${process.env.AWS_REGION}:000000000000:${queueName}`;
console.log(`[ingest] polling ${queueUrl}`);

while (running) {
  try {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 60, MessageSystemAttributeNames: ['All'] }),
    );
    if (Messages.length === 0) continue;
    const event: SQSEvent = { Records: Messages.map((m) => toSqsRecord(m, queueArn)) };
    const { batchItemFailures } = await handler(event, { awsRequestId: crypto.randomUUID() });
    const failed = new Set(batchItemFailures.map((f) => f.itemIdentifier));
    const done = Messages.filter((m) => !failed.has(m.MessageId!));
    if (done.length) {
      await sqs.send(
        new DeleteMessageBatchCommand({ QueueUrl: queueUrl, Entries: done.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })) }),
      );
    }
    console.log(`[ingest] processed ${done.length}/${Messages.length} message(s)${failed.size ? `, ${failed.size} left for retry` : ''}`);
  } catch (err) {
    console.error('[ingest] poll error', err);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
