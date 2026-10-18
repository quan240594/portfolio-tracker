import type { ImportStatus, Transaction } from '@portfolio/shared';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { MemoryFileStore, RecordingEventPublisher } from '@portfolio/platform';
import type { IngestDeps } from '../processor.js';
import type { IngestStore } from '../store.js';

export class InMemoryIngestStore implements IngestStore {
  imports = new Map<string, ImportStatus>();
  transactions: Transaction[] = [];
  users = new Set<string>();
  tracked = new Map<string, string>();
  /** `${userId}/${portfolioId}` of existing portfolios. */
  portfolios = new Set<string>(['demo/default']);
  writes = 0;

  addImport(userId: string, importId: string, status: ImportStatus['status'] = 'PENDING', portfolioId = 'default') {
    const ts = '2026-06-15T00:00:00.000Z';
    this.imports.set(`${userId}/${importId}`, { importId, userId, portfolioId, fileName: 'f.csv', status, createdAt: ts, updatedAt: ts });
    this.portfolios.add(`${userId}/${portfolioId}`);
  }
  imp(userId: string, importId: string) {
    return this.imports.get(`${userId}/${importId}`);
  }
  getImport(userId: string, importId: string) {
    const i = this.imp(userId, importId);
    return Promise.resolve(i ? { ...i } : null);
  }
  markProcessing(userId: string, importId: string) {
    const i = this.imp(userId, importId);
    if (!i || (i.status !== 'PENDING' && i.status !== 'PROCESSING')) return Promise.resolve(false);
    i.status = 'PROCESSING';
    return Promise.resolve(true);
  }
  markFailed(userId: string, importId: string, rowCount: number, errors: { row: number; message: string }[]) {
    return this.settle(() => Object.assign(this.imp(userId, importId)!, { status: 'FAILED', rowCount, importedCount: 0, errors }));
  }
  markCompleted(userId: string, importId: string, rowCount: number, importedCount: number) {
    return this.settle(() => Object.assign(this.imp(userId, importId)!, { status: 'COMPLETED', rowCount, importedCount }));
  }
  portfolioExists(userId: string, portfolioId: string) {
    return Promise.resolve(this.portfolios.has(`${userId}/${portfolioId}`));
  }
  listTransactions(userId: string) {
    return Promise.resolve(this.transactions.filter((t) => t.userId === userId));
  }
  putTransactions(txns: Transaction[]) {
    return this.settle(() => {
      this.writes++;
      for (const t of txns) {
        this.transactions = this.transactions.filter((x) => x.id !== t.id);
        this.transactions.push(t);
      }
    });
  }
  registerUser(userId: string) {
    return this.settle(() => this.users.add(userId));
  }
  trackTickers(tickers: { symbol: string; currency: string }[]) {
    return this.settle(() => {
      for (const t of tickers) this.tracked.set(t.symbol, t.currency);
    });
  }
  /** Runs `fn` and converts a synchronous throw into a rejected promise, like an async method would. */
  private settle(fn: () => unknown): Promise<void> {
    try {
      fn();
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export function fakeIngestDeps() {
  const store = new InMemoryIngestStore();
  const files = new MemoryFileStore();
  const events = new RecordingEventPublisher();
  const deps: IngestDeps = { store, files, events, now: () => new Date('2026-06-15T12:00:00.000Z') };
  return { deps, store, files, events };
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
