import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@portfolio/shared';
import { MAX_OBJECT_BYTES } from './objects.js';
import { processImportObject } from './processor.js';
import { fakeIngestDeps } from './testing/fakes.js';

const BUCKET = 'bucket';
const HEADER = 'date,type,symbol,quantity,price,fee,currency';

const stored = (over: Partial<Transaction>): Transaction => ({
  id: 'x',
  userId: 'demo',
  portfolioId: 'default',
  date: '2025-01-01',
  type: 'BUY',
  symbol: 'MSFT',
  quantity: 5,
  price: 300,
  fee: 0,
  currency: 'USD',
  createdAt: '2025-01-01T00:00:00.000Z',
  ...over,
});

function setup(csv?: string, importId = 'imp1') {
  const ctx = fakeIngestDeps();
  ctx.store.addImport('demo', importId);
  if (csv !== undefined) ctx.reader.objects.set(`${BUCKET}/imports/demo/${importId}.csv`, csv);
  const run = (key = `imports/demo/${importId}.csv`) => processImportObject(ctx.deps, { bucket: BUCKET, key });
  return { ...ctx, run };
}

describe('processImportObject', () => {
  it('ignores keys outside the imports/ layout and keys with broken percent-encoding', async () => {
    const { run, store } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n`);
    expect(await run('other/demo/imp1.csv')).toBe('IGNORED');
    expect(await run('imports/demo/imp1.txt')).toBe('IGNORED');
    expect(await run('imports/demo/%E0%A4%A.csv')).toBe('IGNORED');
    expect(store.imp('demo', 'imp1')!.status).toBe('PENDING');
  });

  it('decodes URL-encoded keys and reads the canonical object key', async () => {
    const ctx = fakeIngestDeps();
    ctx.store.addImport('demo', 'my file');
    ctx.reader.objects.set(`${BUCKET}/imports/demo/my file.csv`, `${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n`);
    const readSpy = vi.spyOn(ctx.reader, 'readText');
    expect(await processImportObject(ctx.deps, { bucket: BUCKET, key: 'imports/demo/my%20file.csv' })).toBe('COMPLETED');
    expect(readSpy).toHaveBeenCalledWith(BUCKET, 'imports/demo/my file.csv', MAX_OBJECT_BYTES);
    expect(ctx.store.transactions.map((t) => t.id)).toEqual(['my file-1']);
  });

  it('returns NOT_FOUND when there is no IMPORT item and touches nothing', async () => {
    const { run, store } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n`);
    const mark = vi.spyOn(store, 'markProcessing');
    expect(await run('imports/demo/unknown.csv')).toBe('NOT_FOUND');
    expect(mark).not.toHaveBeenCalled();
  });

  it.each(['COMPLETED', 'FAILED'] as const)('acknowledges a redelivery of a %s import without re-reading the file', async (status) => {
    const { run, store, reader } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n`);
    store.imp('demo', 'imp1')!.status = status;
    const read = vi.spyOn(reader, 'readText');
    expect(await run()).toBe('ALREADY_DONE');
    expect(read).not.toHaveBeenCalled();
    expect(store.imp('demo', 'imp1')!.status).toBe(status);
  });

  it('acknowledges when the import turns terminal between the read and the conditional update', async () => {
    const { run, store, reader } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n`);
    vi.spyOn(store, 'markProcessing').mockResolvedValue(false);
    const read = vi.spyOn(reader, 'readText');
    expect(await run()).toBe('ALREADY_DONE');
    expect(read).not.toHaveBeenCalled();
    expect(store.transactions).toHaveLength(0);
  });

  it('marks the import FAILED with the reader reason when the file cannot be read', async () => {
    const { run, store } = setup(undefined);
    expect(await run()).toBe('FAILED');
    expect(store.imp('demo', 'imp1')).toMatchObject({ status: 'FAILED', rowCount: 0, importedCount: 0, errors: [{ row: 0, message: 'Uploaded file not found' }] });
  });

  it('marks the import FAILED for header problems, keeping the parsed row count', async () => {
    const { run, store, events } = setup('date,type,symbol\n2025-01-02,BUY,AAPL\n2025-01-03,BUY,AAPL\n');
    expect(await run()).toBe('FAILED');
    expect(store.imp('demo', 'imp1')).toMatchObject({ status: 'FAILED', rowCount: 2, errors: [{ row: 0, message: expect.stringContaining('Missing required column(s)') }] });
    expect(events.published).toEqual([]);
  });

  it('points a mixed-currency conflict inside the file at the row with the conflicting currency', async () => {
    const { run, store } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n2025-01-03,BUY,MSFT,1,1,0,USD\n2025-01-04,BUY,AAPL,1,1,0,EUR\n`);
    expect(await run()).toBe('FAILED');
    expect(store.imp('demo', 'imp1')!.errors).toEqual([{ row: 3, message: 'Mixed currencies for AAPL: USD and EUR' }]);
  });

  it('points a conflict with an existing later transaction at the first row of that symbol', async () => {
    const { run, store } = setup(`${HEADER}\n2025-01-02,BUY,MSFT,1,1,0,USD\n2025-01-03,BUY,MSFT,1,1,0,USD\n`);
    store.transactions.push(stored({ id: 'old', date: '2025-06-01', currency: 'EUR' }));
    expect(await run()).toBe('FAILED');
    expect(store.imp('demo', 'imp1')!.errors).toEqual([{ row: 1, message: 'Mixed currencies for MSFT: EUR and USD' }]);
  });

  it('reports row 0 when the conflict lies entirely in previously stored data', async () => {
    const { run, store } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n`);
    store.transactions.push(stored({ id: 'a', currency: 'USD' }), stored({ id: 'b', date: '2025-02-01', currency: 'EUR' }));
    expect(await run()).toBe('FAILED');
    expect(store.imp('demo', 'imp1')!.errors).toEqual([{ row: 0, message: 'Mixed currencies for MSFT: USD and EUR' }]);
  });

  it('reports row 0 when the import makes an existing later sell oversell', async () => {
    const { run, store } = setup(`${HEADER}\n2025-03-01,SELL,MSFT,3,400,0,USD\n`);
    store.transactions.push(stored({ id: 'buy' }), stored({ id: 'sell', date: '2025-06-01', type: 'SELL' }));
    expect(await run()).toBe('FAILED');
    expect(store.imp('demo', 'imp1')!.errors).toEqual([{ row: 0, message: 'Cannot sell 5 MSFT on 2025-06-01: only 2 held' }]);
    expect(store.writes).toBe(0);
  });

  it('only attributes an oversell to a SELL row with the same symbol, date and quantity', async () => {
    const { run, store } = setup(
      `${HEADER}\n2025-01-02,BUY,AAPL,2,1,0,USD\n2025-01-05,BUY,AAPL,3,1,0,USD\n2025-01-05,SELL,AAPL,2,1,0,USD\n2025-01-05,SELL,AAPL,4,1,0,USD\n`,
    );
    expect(await run()).toBe('FAILED');
    expect(store.imp('demo', 'imp1')!.errors).toEqual([{ row: 4, message: expect.stringContaining('Cannot sell 4 AAPL on 2025-01-05') }]);
  });

  it('rethrows non-domain errors from position replay so the message is retried', async () => {
    const { run, store } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n`);
    // A corrupt stored item (BigInt quantity) makes the replay throw a TypeError rather than a PortfolioError.
    store.transactions.push(stored({ id: 'bad', quantity: 5n as unknown as number }));
    await expect(run()).rejects.toThrow(TypeError);
    expect(store.imp('demo', 'imp1')!.status).toBe('PROCESSING');
    expect(store.writes).toBe(0);
  });

  it('propagates infrastructure failures after the write so redelivery can finish the import', async () => {
    const { run, store, events } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n`);
    vi.spyOn(events, 'transactionsChanged').mockRejectedValueOnce(new Error('PutEvents failed: InternalFailure'));
    await expect(run()).rejects.toThrow('PutEvents failed');
    expect(store.imp('demo', 'imp1')!.status).toBe('PROCESSING');
    expect(await run()).toBe('COMPLETED');
    expect(store.transactions).toHaveLength(1);
  });

  it('tracks each ticker once with its currency and publishes sorted symbols', async () => {
    const { run, store, events } = setup(`${HEADER}\n2025-01-02,BUY,MSFT,1,1,0,USD\n2025-01-02,BUY,ASML.AS,1,1,0,EUR\n2025-01-03,BUY,MSFT,1,1,0,USD\n`);
    const track = vi.spyOn(store, 'trackTickers');
    expect(await run()).toBe('COMPLETED');
    expect(track).toHaveBeenCalledWith([
      { symbol: 'MSFT', currency: 'USD' },
      { symbol: 'ASML.AS', currency: 'EUR' },
    ]);
    expect(events.published).toEqual([{ userId: 'demo', portfolioId: 'default', symbols: ['ASML.AS', 'MSFT'], reason: 'IMPORTED', importId: 'imp1' }]);
    expect(store.imp('demo', 'imp1')).toMatchObject({ status: 'COMPLETED', rowCount: 3, importedCount: 3 });
  });

  it('persists a broker fxRate and omits it when the column is empty or absent', async () => {
    const { run, store } = setup(`${HEADER},FxRate\n2025-01-02,BUY,AAPL,10,150,1,USD,1.0842\n2025-01-03,BUY,ASML.AS,1,600,1,EUR,\n`);
    expect(await run()).toBe('COMPLETED');
    expect(store.transactions[0]).toMatchObject({ id: 'imp1-1', symbol: 'AAPL', currency: 'USD', fxRate: 1.0842 });
    expect(store.transactions[1]).not.toHaveProperty('fxRate');
    expect(store.transactions[1]).not.toHaveProperty('note');
  });

  it('marks the import FAILED with a row error for an invalid fxRate and writes nothing', async () => {
    const { run, store } = setup(`${HEADER},fxRate\n2025-01-02,BUY,AAPL,10,150,1,USD,1.08\n2025-01-03,BUY,AAPL,1,150,1,USD,-2\n`);
    expect(await run()).toBe('FAILED');
    expect(store.transactions).toHaveLength(0);
    expect(store.imp('demo', 'imp1')).toMatchObject({ status: 'FAILED', rowCount: 2, errors: [{ row: 2, message: expect.stringMatching(/^fxRate: /) }] });
  });

  describe('target portfolio', () => {
    it('fails an import without a target portfolio before reading the file', async () => {
      const { run, store, reader } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n`);
      delete (store.imp('demo', 'imp1') as { portfolioId?: string }).portfolioId;
      const read = vi.spyOn(reader, 'readText');
      expect(await run()).toBe('FAILED');
      expect(store.imp('demo', 'imp1')).toMatchObject({ status: 'FAILED', rowCount: 0, errors: [{ row: 0, message: 'Import has no target portfolio' }] });
      expect(read).not.toHaveBeenCalled();
    });

    it('fails when the target portfolio no longer exists', async () => {
      const { run, store, events } = setup(`${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n`);
      store.portfolios.delete('demo/default');
      expect(await run()).toBe('FAILED');
      expect(store.imp('demo', 'imp1')).toMatchObject({ status: 'FAILED', errors: [{ row: 0, message: 'Portfolio default not found' }] });
      expect(store.writes).toBe(0);
      expect(events.published).toEqual([]);
    });

    it('writes the rows into the import portfolio and publishes it', async () => {
      const ctx = fakeIngestDeps();
      ctx.store.addImport('demo', 'imp9', 'PENDING', 'broker');
      ctx.reader.objects.set(`${BUCKET}/imports/demo/imp9.csv`, `${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n`);
      expect(await processImportObject(ctx.deps, { bucket: BUCKET, key: 'imports/demo/imp9.csv' })).toBe('COMPLETED');
      expect(ctx.store.transactions).toEqual([expect.objectContaining({ id: 'imp9-1', portfolioId: 'broker', importId: 'imp9' })]);
      expect(ctx.events.published).toEqual([{ userId: 'demo', portfolioId: 'broker', symbols: ['AAPL'], reason: 'IMPORTED', importId: 'imp9' }]);
    });

    it('validates overselling against the target portfolio only', async () => {
      const csv = `${HEADER}\n2025-03-01,SELL,MSFT,3,400,0,USD\n`;
      const intoDefault = setup(csv);
      intoDefault.store.transactions.push(stored({ id: 'b', portfolioId: 'broker' }));
      expect(await intoDefault.run()).toBe('FAILED');
      expect(intoDefault.store.imp('demo', 'imp1')!.errors).toEqual([{ row: 1, message: 'Cannot sell 3 MSFT on 2025-03-01: only 0 held' }]);

      const intoBroker = fakeIngestDeps();
      intoBroker.store.addImport('demo', 'imp2', 'PENDING', 'broker');
      intoBroker.reader.objects.set(`${BUCKET}/imports/demo/imp2.csv`, csv);
      // A later oversell stored in another portfolio does not block this import.
      intoBroker.store.transactions.push(stored({ id: 'b' }), stored({ id: 'x', portfolioId: 'broker' }), stored({ id: 's', date: '2025-06-01', type: 'SELL', quantity: 9 }));
      expect(await processImportObject(intoBroker.deps, { bucket: BUCKET, key: 'imports/demo/imp2.csv' })).toBe('COMPLETED');
    });

    it('rejects the first row whose currency differs from the symbol currency in any portfolio', async () => {
      const { run, store } = setup(`${HEADER}\n2025-01-02,BUY,MSFT,1,1,0,USD\n2025-01-03,BUY,AAPL,1,1,0,EUR\n2025-01-04,BUY,AAPL,1,1,0,GBP\n`);
      store.transactions.push(stored({ id: 'a', portfolioId: 'broker', symbol: 'AAPL', currency: 'USD' }));
      expect(await run()).toBe('FAILED');
      expect(store.imp('demo', 'imp1')).toMatchObject({ rowCount: 3, errors: [{ row: 2, message: 'Mixed currencies for AAPL: USD and EUR' }] });
      expect(store.writes).toBe(0);
    });

    it('ignores other users when checking currencies', async () => {
      const { run, store } = setup(`${HEADER}\n2025-01-02,BUY,MSFT,1,1,0,EUR\n`);
      store.transactions.push(stored({ id: 'o', userId: 'someone-else' }));
      expect(await run()).toBe('COMPLETED');
    });
  });
});
