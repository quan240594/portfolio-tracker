import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandler } from './app.js';
import { logger } from './logger.js';
import { eventBridgeBody, fakeIngestDeps, s3NotificationBody, sqsEvent } from './testing/fakes.js';

const BUCKET = 'portfolio-tracker-imports-test';
const HEADER = 'date,type,symbol,quantity,price,fee,currency,note';
const GOOD_CSV = `${HEADER}
2025-01-02,BUY,AAPL,10,150,1,USD,first buy
2025-01-02,SELL,AAPL,4,155,1,USD,
2025-02-01,BUY,VWRL.AS,5,100,0,EUR,
2025-03-01,DIVIDEND,AAPL,6,0.25,0.04,USD,
`;

function setup(csv = GOOD_CSV, importId = 'imp1', userId = 'demo') {
  const ctx = fakeIngestDeps();
  ctx.store.addImport(userId, importId);
  ctx.reader.objects.set(`${BUCKET}/imports/${userId}/${importId}.csv`, csv);
  return { ...ctx, handler: createHandler(() => ctx.deps), key: `imports/${userId}/${importId}.csv` };
}

describe('ingest handler', () => {
  it('imports a CSV delivered as an EventBridge Object Created event', async () => {
    const { handler, store, events, key } = setup();
    const res = await handler(sqsEvent(eventBridgeBody(BUCKET, key)));
    expect(res.batchItemFailures).toEqual([]);
    expect(store.imp('demo', 'imp1')).toMatchObject({ status: 'COMPLETED', rowCount: 4, importedCount: 4 });
    expect(store.transactions.map((t) => t.id)).toEqual(['imp1-1', 'imp1-2', 'imp1-3', 'imp1-4']);
    expect(store.transactions[0]).toMatchObject({ userId: 'demo', portfolioId: 'default', importId: 'imp1', symbol: 'AAPL', note: 'first buy', createdAt: '2026-06-15T12:00:00.001Z' });
    expect(store.transactions[1]).not.toHaveProperty('note');
    expect(store.users.has('demo')).toBe(true);
    expect([...store.tracked]).toEqual([['AAPL', 'USD'], ['VWRL.AS', 'EUR']]);
    expect(events.published).toEqual([{ userId: 'demo', portfolioId: 'default', symbols: ['AAPL', 'VWRL.AS'], reason: 'IMPORTED', importId: 'imp1' }]);
  });

  it('imports a CSV delivered as an S3 notification (LocalStack shape)', async () => {
    const { handler, store, key } = setup();
    const res = await handler(sqsEvent(s3NotificationBody(BUCKET, key)));
    expect(res.batchItemFailures).toEqual([]);
    expect(store.imp('demo', 'imp1')!.status).toBe('COMPLETED');
    expect(store.transactions).toHaveLength(4);
  });

  it('is all-or-nothing: one bad row fails the import and writes nothing', async () => {
    const { handler, store, events, key } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,10,150,1,USD,\n2025-01-03,BUY,AAPL,ten,150,1,USD,\n`);
    const res = await handler(sqsEvent(eventBridgeBody(BUCKET, key)));
    expect(res.batchItemFailures).toEqual([]);
    const imp = store.imp('demo', 'imp1')!;
    expect(imp).toMatchObject({ status: 'FAILED', rowCount: 2, importedCount: 0 });
    expect(imp.errors).toEqual([{ row: 2, message: expect.stringContaining('quantity') }]);
    expect(store.transactions).toHaveLength(0);
    expect(store.writes).toBe(0);
    expect(events.published).toHaveLength(0);
  });

  it('rejects an import that would oversell, pointing at the offending row', async () => {
    const { handler, store, key } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,2,150,1,USD,\n2025-01-05,SELL,AAPL,3,150,1,USD,\n`);
    await handler(sqsEvent(eventBridgeBody(BUCKET, key)));
    const imp = store.imp('demo', 'imp1')!;
    expect(imp.status).toBe('FAILED');
    expect(imp.errors).toEqual([{ row: 2, message: expect.stringContaining('Cannot sell 3 AAPL') }]);
    expect(store.transactions).toHaveLength(0);
  });

  it('validates against the user existing transactions', async () => {
    const { handler, store, key } = setup(`${HEADER}\n2025-06-01,SELL,MSFT,5,400,0,USD,\n`);
    store.transactions.push({ id: 'x', userId: 'demo', portfolioId: 'default', date: '2025-01-01', type: 'BUY', symbol: 'MSFT', quantity: 5, price: 300, fee: 0, currency: 'USD', createdAt: '2025-01-01T00:00:00Z' });
    await handler(sqsEvent(eventBridgeBody(BUCKET, key)));
    expect(store.imp('demo', 'imp1')!.status).toBe('COMPLETED');
  });

  it('acks redelivery of a COMPLETED import without writing again (idempotent)', async () => {
    const { handler, store, events, key } = setup();
    await handler(sqsEvent(eventBridgeBody(BUCKET, key)));
    const writes = store.writes;
    const res = await handler(sqsEvent(eventBridgeBody(BUCKET, key)));
    expect(res.batchItemFailures).toEqual([]);
    expect(store.writes).toBe(writes);
    expect(events.published).toHaveLength(1);
    expect(store.transactions).toHaveLength(4);
  });

  it('resumes an import left PROCESSING without double-counting its own rows', async () => {
    const { handler, store, key } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,2,150,1,USD,\n2025-01-05,SELL,AAPL,2,150,1,USD,\n`);
    store.imp('demo', 'imp1')!.status = 'PROCESSING';
    // A previous attempt wrote the rows and crashed before COMPLETED.
    store.transactions.push(
      { id: 'imp1-1', importId: 'imp1', userId: 'demo', portfolioId: 'default', date: '2025-01-02', type: 'BUY', symbol: 'AAPL', quantity: 2, price: 150, fee: 1, currency: 'USD', createdAt: 'a' },
      { id: 'imp1-2', importId: 'imp1', userId: 'demo', portfolioId: 'default', date: '2025-01-05', type: 'SELL', symbol: 'AAPL', quantity: 2, price: 150, fee: 1, currency: 'USD', createdAt: 'b' },
    );
    await handler(sqsEvent(eventBridgeBody(BUCKET, key)));
    expect(store.imp('demo', 'imp1')!.status).toBe('COMPLETED');
    expect(store.transactions).toHaveLength(2);
  });

  it('reports only the throttled message as a batch item failure and does not mark it FAILED', async () => {
    const ctx = setup();
    ctx.store.addImport('demo', 'imp2');
    ctx.reader.objects.set(`${BUCKET}/imports/demo/imp2.csv`, GOOD_CSV);
    const original = ctx.store.listTransactions.bind(ctx.store);
    let calls = 0;
    ctx.store.listTransactions = async (userId: string) => {
      if (++calls === 2) {
        const err = new Error('Rate exceeded');
        err.name = 'ThrottlingException';
        throw err;
      }
      return original(userId);
    };
    const res = await ctx.handler(sqsEvent(eventBridgeBody(BUCKET, ctx.key), eventBridgeBody(BUCKET, 'imports/demo/imp2.csv')));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
    expect(ctx.store.imp('demo', 'imp1')!.status).toBe('COMPLETED');
    expect(ctx.store.imp('demo', 'imp2')!.status).toBe('PROCESSING');

    // Redelivery succeeds once the throttling stops.
    const retry = await ctx.handler(sqsEvent(eventBridgeBody(BUCKET, 'imports/demo/imp2.csv')));
    expect(retry.batchItemFailures).toEqual([]);
    expect(ctx.store.imp('demo', 'imp2')!.status).toBe('COMPLETED');
  });

  it('acks objects outside the imports/ layout and unknown imports', async () => {
    const { handler, store } = setup();
    const res = await handler(sqsEvent(eventBridgeBody(BUCKET, 'other/file.csv'), eventBridgeBody(BUCKET, 'imports/demo/unknown.csv'), 'garbage'));
    expect(res.batchItemFailures).toEqual([]);
    expect(store.transactions).toHaveLength(0);
  });

  it('fails the import when the file is too large or missing', async () => {
    const big = `${HEADER}\n` + `2025-01-02,BUY,AAPL,1,1,0,USD,${'x'.repeat(400)}\n`.repeat(2700);
    const { handler, store, key } = setup(big);
    await handler(sqsEvent(eventBridgeBody(BUCKET, key)));
    expect(store.imp('demo', 'imp1')).toMatchObject({ status: 'FAILED', errors: [{ row: 0, message: expect.stringMatching(/too large/i) }] });

    store.addImport('demo', 'gone');
    await handler(sqsEvent(eventBridgeBody(BUCKET, 'imports/demo/gone.csv')));
    expect(store.imp('demo', 'gone')).toMatchObject({ status: 'FAILED', errors: [{ row: 0, message: 'Uploaded file not found' }] });
  });

  it('caps reported errors at 100', async () => {
    const { handler, store, key } = setup(`${HEADER}\n` + '2025-01-02,BUY,AAPL,-1,1,0,USD,\n'.repeat(150));
    await handler(sqsEvent(eventBridgeBody(BUCKET, key)));
    expect(store.imp('demo', 'imp1')!.errors).toHaveLength(100);
    expect(store.imp('demo', 'imp1')!.rowCount).toBe(150);
  });

  describe('refs within one message', () => {
    const multiBody = (...keys: string[]) =>
      JSON.stringify({
        Records: keys.map((key) => ({ eventName: 'ObjectCreated:Put', s3: { bucket: { name: BUCKET }, object: { key } } })),
      });
    const csvFor = (symbol: string) => `${HEADER}\n2025-01-02,BUY,${symbol},1,10,0,USD,\n`;

    function multiSetup(refs: [userId: string, importId: string][]) {
      const ctx = fakeIngestDeps();
      for (const [userId, importId] of refs) {
        ctx.store.addImport(userId, importId);
        ctx.reader.objects.set(`${BUCKET}/imports/${userId}/${importId}.csv`, csvFor('AAPL'));
      }
      const handler = createHandler(() => ctx.deps);
      const body = multiBody(...refs.map(([u, i]) => `imports/${u}/${i}.csv`));
      return { ...ctx, handler, body };
    }

    it('processes the refs of one user strictly in order while other users run concurrently', async () => {
      const { handler, reader, body, store } = multiSetup([['alice', 'a1'], ['alice', 'a2'], ['bob', 'b1']]);
      const trace: string[] = [];
      const gates = new Map<string, () => void>();
      const original = reader.readText.bind(reader);
      reader.readText = async (bucket, key, max) => {
        trace.push(`start ${key}`);
        // alice's first import only finishes after bob's has started, proving the groups overlap.
        if (key.endsWith('alice/a1.csv')) await new Promise<void>((resolve) => gates.set('a1', resolve));
        if (key.endsWith('bob/b1.csv')) gates.get('a1')!();
        const res = await original(bucket, key, max);
        trace.push(`end ${key}`);
        return res;
      };
      const res = await handler(sqsEvent(body));
      expect(res.batchItemFailures).toEqual([]);
      const idx = (entry: string) => trace.indexOf(entry);
      expect(idx('start imports/bob/b1.csv')).toBeLessThan(idx('end imports/alice/a1.csv'));
      expect(idx('end imports/alice/a1.csv')).toBeLessThan(idx('start imports/alice/a2.csv'));
      for (const [u, i] of [['alice', 'a1'], ['alice', 'a2'], ['bob', 'b1']]) expect(store.imp(u!, i!)!.status).toBe('COMPLETED');
    });

    it('stops a user group at its first failure but lets other groups finish, then retries the message', async () => {
      const { handler, store, body } = multiSetup([['alice', 'a1'], ['alice', 'a2'], ['bob', 'b1']]);
      const original = store.markProcessing.bind(store);
      store.markProcessing = async (userId, importId) => {
        if (importId === 'a1') throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
        return original(userId, importId);
      };
      const error = vi.spyOn(logger, 'error');
      const res = await handler(sqsEvent(body, eventBridgeBody(BUCKET, 'other/x.csv')));
      expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
      expect(error).toHaveBeenCalledWith('Transient failure; message will be retried', { messageId: 'm1', error: expect.objectContaining({ message: 'Rate exceeded' }) });
      expect(store.imp('alice', 'a1')!.status).toBe('PENDING');
      expect(store.imp('alice', 'a2')!.status).toBe('PENDING');
      expect(store.imp('bob', 'b1')!.status).toBe('COMPLETED');
      error.mockRestore();
    });

    it('reports the first failure in message order when several groups fail', async () => {
      const { handler, store, body } = multiSetup([['alice', 'a1'], ['bob', 'b1']]);
      store.markProcessing = (userId) => Promise.reject(new Error(`boom ${userId}`));
      const error = vi.spyOn(logger, 'error');
      await handler(sqsEvent(body));
      expect(error).toHaveBeenCalledWith(expect.any(String), { messageId: 'm1', error: expect.objectContaining({ message: 'boom alice' }) });
      error.mockRestore();
    });
  });

  describe('logging context and acknowledgement', () => {
    afterEach(() => vi.restoreAllMocks());

    it('scopes the Lambda request id to the invocation', async () => {
      const { handler, key } = setup();
      const append = vi.spyOn(logger, 'appendKeys');
      const remove = vi.spyOn(logger, 'removeKeys');
      await handler(sqsEvent(eventBridgeBody(BUCKET, key)), { awsRequestId: 'req-1' });
      expect(append).toHaveBeenCalledWith({ requestId: 'req-1' });
      expect(remove).toHaveBeenCalledWith(['requestId']);
      await handler(sqsEvent());
      expect(append).toHaveBeenLastCalledWith({ requestId: undefined });
    });

    it('acknowledges malformed and reference-free bodies with a warning', async () => {
      const { handler, store } = setup();
      const warn = vi.spyOn(logger, 'warn');
      const res = await handler(sqsEvent('{not json', JSON.stringify({ Event: 's3:TestEvent' }), 'null'));
      expect(res.batchItemFailures).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no S3 object references'), { messageId: 'm2' });
      expect(store.imp('demo', 'imp1')!.status).toBe('PENDING');
    });

    it('logs the outcome of each processed object', async () => {
      const { handler, key } = setup();
      const info = vi.spyOn(logger, 'info');
      await handler(sqsEvent(eventBridgeBody(BUCKET, key), eventBridgeBody(BUCKET, 'other/x.csv')));
      const outcomes = info.mock.calls.filter(([msg]) => msg === 'Processed object').map(([, extra]) => extra);
      expect(outcomes).toEqual([
        expect.objectContaining({ messageId: 'm1', key, outcome: 'COMPLETED', latencyMs: expect.any(Number) }),
        expect.objectContaining({ messageId: 'm2', key: 'other/x.csv', outcome: 'IGNORED' }),
      ]);
    });

    it('fails the whole import when a note contains an unquoted comma', async () => {
      const { handler, store, events, key } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,10,150,1,USD,first\n2025-01-03,BUY,AAPL,1,150,1,USD,dip, again\n`);
      const res = await handler(sqsEvent(eventBridgeBody(BUCKET, key)));
      expect(res.batchItemFailures).toEqual([]);
      expect(store.imp('demo', 'imp1')).toMatchObject({
        status: 'FAILED',
        rowCount: 2,
        errors: [{ row: 2, message: 'Expected 8 fields but found 9 — quote values containing commas' }],
      });
      expect(store.transactions).toHaveLength(0);
      expect(events.published).toHaveLength(0);
    });

    it('imports a URL-encoded S3 notification key', async () => {
      const { handler, store } = setup(GOOD_CSV, 'my report');
      const res = await handler(sqsEvent(s3NotificationBody(BUCKET, 'imports/demo/my+report.csv')));
      expect(res.batchItemFailures).toEqual([]);
      expect(store.imp('demo', 'my report')!.status).toBe('COMPLETED');
    });

    it('fails the import (not the message) when the CSV is empty or the header is broken', async () => {
      const empty = setup('');
      await empty.handler(sqsEvent(eventBridgeBody(BUCKET, empty.key)));
      expect(empty.store.imp('demo', 'imp1')).toMatchObject({ status: 'FAILED', errors: [{ row: 0, message: 'CSV contains no data rows' }] });

      const dup = setup(`${HEADER},Symbol\n2025-01-02,BUY,AAPL,1,1,0,USD,note,MSFT\n`);
      const res = await dup.handler(sqsEvent(eventBridgeBody(BUCKET, dup.key)));
      expect(res.batchItemFailures).toEqual([]);
      expect(dup.store.imp('demo', 'imp1')).toMatchObject({ status: 'FAILED', errors: [{ row: 0, message: 'Duplicate column(s): symbol' }] });
    });
  });
});

