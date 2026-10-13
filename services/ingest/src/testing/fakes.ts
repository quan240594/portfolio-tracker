import type { ImportStatus, Transaction, TransactionsChangedDetail } from '@portfolio/shared';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import type { EventPublisher } from '../events.js';
import type { ObjectReader, ReadResult } from '../objects.js';
import type { IngestDeps } from '../processor.js';
import type { IngestStore } from '../store.js';

export class InMemoryIngestStore implements IngestStore {
  imports = new Map<string, ImportStatus>();
  transactions: Transaction[] = [];
  users = new Set<string>();
  tracked = new Map<string, string>();
  writes = 0;

  addImport(userId: string, importId: string, status: ImportStatus['status'] = 'PENDING') {
    const ts = '2026-06-15T00:00:00.000Z';
    this.imports.set(`${userId}/${importId}`, { importId, userId, fileName: 'f.csv', status, createdAt: ts, updatedAt: ts });
  }
  imp(userId: string, importId: string) {
    return this.imports.get(`${userId}/${importId}`);
  }
  async getImport(userId: string, importId: string) {
    const i = this.imp(userId, importId);
    return i ? { ...i } : null;
  }
  async markProcessing(userId: string, importId: string) {
    const i = this.imp(userId, importId);
    if (!i || (i.status !== 'PENDING' && i.status !== 'PROCESSING')) return false;
    i.status = 'PROCESSING';
    return true;
  }
  async markFailed(userId: string, importId: string, rowCount: number, errors: { row: number; message: string }[]) {
    Object.assign(this.imp(userId, importId)!, { status: 'FAILED', rowCount, importedCount: 0, errors });
  }
  async markCompleted(userId: string, importId: string, rowCount: number, importedCount: number) {
    Object.assign(this.imp(userId, importId)!, { status: 'COMPLETED', rowCount, importedCount });
  }
  async listTransactions(userId: string) {
    return this.transactions.filter((t) => t.userId === userId);
  }
  async putTransactions(txns: Transaction[]) {
    this.writes++;
    for (const t of txns) {
      this.transactions = this.transactions.filter((x) => x.id !== t.id);
      this.transactions.push(t);
    }
  }
  async registerUser(userId: string) {
    this.users.add(userId);
  }
  async trackTickers(tickers: { symbol: string; currency: string }[]) {
    for (const t of tickers) this.tracked.set(t.symbol, t.currency);
  }
}

export class FakeReader implements ObjectReader {
  objects = new Map<string, string>();
  async readText(bucket: string, key: string, maxBytes: number): Promise<ReadResult> {
    const content = this.objects.get(`${bucket}/${key}`);
    if (content === undefined) return { ok: false, reason: 'Uploaded file not found' };
    if (Buffer.byteLength(content) > maxBytes) return { ok: false, reason: 'File too large' };
    return { ok: true, content };
  }
}

export class RecordingPublisher implements EventPublisher {
  published: TransactionsChangedDetail[] = [];
  async transactionsChanged(detail: TransactionsChangedDetail) {
    this.published.push(detail);
  }
}

export function fakeIngestDeps() {
  const store = new InMemoryIngestStore();
  const reader = new FakeReader();
  const events = new RecordingPublisher();
  const deps: IngestDeps = { store, reader, events, now: () => new Date('2026-06-15T12:00:00.000Z') };
  return { deps, store, reader, events };
}

export const eventBridgeBody = (bucket: string, key: string) =>
  JSON.stringify({
    version: '0',
    id: 'e1',
    'detail-type': 'Object Created',
    source: 'aws.s3',
    region: 'eu-west-1',
    resources: [`arn:aws:s3:::${bucket}`],
    detail: { version: '0', bucket: { name: bucket }, object: { key, size: 10 }, reason: 'PutObject' },
  });

export const s3NotificationBody = (bucket: string, key: string) =>
  JSON.stringify({
    Records: [{ eventVersion: '2.1', eventSource: 'aws:s3', eventName: 'ObjectCreated:Put', s3: { bucket: { name: bucket }, object: { key, size: 10 } } }],
  });

export const sqsEvent = (...bodies: string[]): SQSEvent => ({
  Records: bodies.map(
    (body, i): SQSRecord => ({
      messageId: `m${i + 1}`,
      receiptHandle: `rh${i + 1}`,
      body,
      attributes: { ApproximateReceiveCount: '1', SentTimestamp: '0', SenderId: 'x', ApproximateFirstReceiveTimestamp: '0' },
      messageAttributes: {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:eu-west-1:000000000000:q',
      awsRegion: 'eu-west-1',
    }),
  ),
});
