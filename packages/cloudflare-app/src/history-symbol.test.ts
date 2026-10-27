import { BudgetGuard, JOBS, METRIC_LIMITS, MemoryItemStore, MemoryUsageStore, type JobMessage, type JobQueue } from '@portfolio/platform';
import { PriceRepository } from '@portfolio/prices';
import { describe, expect, it } from 'vitest';
import { createHistorySymbolApi } from './history-symbol.js';

const NOW = new Date('2026-10-13T16:30:00.000Z');

class RecordingQueue implements JobQueue {
  readonly messages: JobMessage[] = [];
  failWith: Error | undefined;

  enqueue<N extends keyof typeof JOBS>(message: JobMessage<N>): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.messages.push(message as JobMessage);
    return Promise.resolve();
  }
}

function setup(options: { workerRequests?: number; used?: number } = {}) {
  const items = new MemoryItemStore();
  const queue = new RecordingQueue();
  const guard = new BudgetGuard({ store: new MemoryUsageStore(), now: () => NOW, limits: { ...METRIC_LIMITS, workerRequests: options.workerRequests ?? 1000 } });
  const repo = new PriceRepository(items);
  const api = createHistorySymbolApi({ items, queue, guard, now: () => NOW });
  return { items, queue, guard, repo, api, ready: options.used === undefined ? Promise.resolve() : guard.record({ workerRequests: options.used }) };
}

const enrichment = (symbol: string): JobMessage => ({ job: JOBS.enrichTransactions, payload: { userId: '', portfolioId: '', reason: 'IMPORTED', symbols: [symbol] } });

describe('createHistorySymbolApi', () => {
  it('stores the symbol as pending and queues the enrichment of the held symbol at once', async () => {
    const { api, queue, repo } = setup();
    await api.changed('FWRA.MI', 'FWRA.DE');
    expect(await repo.getHistorySymbol('FWRA.MI')).toEqual({ symbol: 'FWRA.MI', historySymbol: 'FWRA.DE', status: 'pending', reason: null, setAt: NOW.toISOString() });
    expect(queue.messages).toEqual([enrichment('FWRA.MI')]);
  });

  it('starts the history of an earlier outcome over when the symbol changes', async () => {
    const { api, repo } = setup();
    await repo.putHistorySymbol({ symbol: 'FWRA.MI', historySymbol: 'FWRA.DE', status: 'refused', reason: 'x', setAt: '2026-10-01T00:00:00.000Z' });
    await api.changed('FWRA.MI', 'FWRA.AS');
    expect(await repo.getHistorySymbol('FWRA.MI')).toMatchObject({ historySymbol: 'FWRA.AS', status: 'pending', reason: null });
  });

  it('forgets a cleared symbol without queuing anything', async () => {
    const { api, queue, repo } = setup();
    await api.changed('FWRA.MI', 'FWRA.DE');
    queue.messages.length = 0;
    await api.changed('FWRA.MI', null);
    expect(await repo.getHistorySymbol('FWRA.MI')).toBeUndefined();
    expect(queue.messages).toEqual([]);
    await expect(api.changed('NEVER.SET', null)).resolves.toBeUndefined();
  });

  it('keeps the symbol pending but queues nothing when the budget guard refuses enrichment', async () => {
    // 85 of 100 requests: blocked, which stops every job (enrichment is allowed up to the warning band only)
    const { api, queue, repo, ready } = setup({ workerRequests: 100, used: 85 });
    await ready;
    await api.changed('FWRA.MI', 'FWRA.DE');
    expect(queue.messages).toEqual([]);
    expect(await repo.getHistorySymbol('FWRA.MI')).toMatchObject({ status: 'pending' });
  });

  it('still queues in the warning band: enrichment follows a change the owner just made', async () => {
    const { api, queue, ready } = setup({ workerRequests: 100, used: 70 });
    await ready;
    await api.changed('FWRA.MI', 'FWRA.DE');
    expect(queue.messages).toEqual([enrichment('FWRA.MI')]);
  });

  it('queues nothing when the symbol was tried the most it may be today, and again the next day', async () => {
    const { api, queue, repo, items } = setup();
    await repo.putAttempts('override', 'FWRA.MI', '2026-10-13', 3, 'retry', 'timeout');
    await api.changed('FWRA.MI', 'FWRA.DE');
    expect(queue.messages).toEqual([]);
    const tomorrow = createHistorySymbolApi({ items, queue, guard: new BudgetGuard({ store: new MemoryUsageStore() }), now: () => new Date('2026-10-14T08:00:00.000Z') });
    await tomorrow.changed('FWRA.MI', 'FWRA.DE');
    expect(queue.messages).toEqual([enrichment('FWRA.MI')]);
  });

  it('queues nothing while the provider that serves the symbol is limited until its reset', async () => {
    const { api, queue, items } = setup();
    await items.put({ PK: 'USAGE', SK: 'BLOCK#eodhd', entityType: 'PROVIDER_BLOCK', provider: 'eodhd', until: NOW.getTime() + 3_600_000, scope: 'day', reason: 'quota', setAt: NOW.toISOString() });
    await api.changed('FWRA.MI', 'FWRA.DE');
    expect(queue.messages).toEqual([]);
    // another provider is not affected: a bare symbol is served by Twelve Data
    await api.changed('FWRA.MI', 'FWRA');
    expect(queue.messages).toEqual([enrichment('FWRA.MI')]);
  });

  it('keeps the symbol and does not fail the save when the queue is down', async () => {
    const { api, queue, repo } = setup();
    queue.failWith = new Error('queue down');
    await expect(api.changed('FWRA.MI', 'FWRA.DE')).resolves.toBeUndefined();
    expect(await repo.getHistorySymbol('FWRA.MI')).toMatchObject({ status: 'pending' });
  });

  it('only keeps the symbol when no price service is registered', async () => {
    const items = new MemoryItemStore();
    const api = createHistorySymbolApi({ items, guard: new BudgetGuard({ store: new MemoryUsageStore() }), now: () => NOW });
    await api.changed('FWRA.MI', 'FWRA.DE');
    expect(await new PriceRepository(items).getHistorySymbol('FWRA.MI')).toMatchObject({ historySymbol: 'FWRA.DE', status: 'pending' });
  });
});
