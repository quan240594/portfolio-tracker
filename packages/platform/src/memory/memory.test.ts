import { describe, expect, it, vi } from 'vitest';
import { runFileStoreContract, runItemStoreContract, runJobQueueContract, runSecretStoreContract, runUsageStoreContract } from '../testing/index.js';
import { JOBS } from '../job.js';
import { MemoryFileStore } from './file-store.js';
import { MemoryItemStore } from './item-store.js';
import { MemoryJobQueue } from './job-queue.js';
import { MemorySecretStore } from './secret-store.js';
import { MemoryUsageStore } from './usage-store.js';

runItemStoreContract('MemoryItemStore', () => new MemoryItemStore());
runSecretStoreContract('MemorySecretStore', () => new MemorySecretStore());
runUsageStoreContract('MemoryUsageStore', () => new MemoryUsageStore());
runFileStoreContract('MemoryFileStore', () => {
  const store = new MemoryFileStore();
  return { store, upload: (target, content) => Promise.resolve(store.accept(target, content)) };
});
runJobQueueContract('MemoryJobQueue', () => {
  const queue = new MemoryJobQueue();
  return {
    queue,
    register: (handler) => {
      queue.register(JOBS.syncBroker, handler);
    },
    drain: () => queue.drain(),
  };
});

describe('MemoryItemStore', () => {
  it('exposes copies of its content for assertions', async () => {
    const store = new MemoryItemStore();
    await store.put({ PK: 'a', SK: 'b', v: 1 });
    expect(store.size).toBe(1);
    const [item] = store.snapshot();
    item!.v = 2;
    expect((await store.get({ PK: 'a', SK: 'b' }))?.v).toBe(1);
  });

  it('loads seed items synchronously, as copies', async () => {
    const seed = { PK: 'a', SK: 'b', v: 1 };
    const store = new MemoryItemStore().load([seed]);
    seed.v = 2;
    expect(store.size).toBe(1);
    expect((await store.get({ PK: 'a', SK: 'b' }))?.v).toBe(1);
  });

  it('rejects a malformed cursor', async () => {
    await expect(new MemoryItemStore().query({ pk: 'a', cursor: '***' })).rejects.toThrow('Invalid query cursor');
  });
});

describe('MemorySecretStore', () => {
  it('lists names but never leaks values through serialisation', async () => {
    const store = new MemorySecretStore();
    await store.put('n', 'super-secret');
    expect(store.names()).toEqual(['n']);
    expect(JSON.stringify(store)).not.toContain('super-secret');
  });
});

describe('MemoryFileStore', () => {
  it('builds upload URLs under its base URL', async () => {
    const target = await new MemoryFileStore('https://files.example').createUpload({ key: 'imports/u/i.csv', contentType: 'text/csv', expiresInSeconds: 60 });
    expect(target.url).toBe('https://files.example/imports/u/i.csv?expires=60');
  });
});

describe('MemoryJobQueue', () => {
  it('records messages, results and dead letters, redelivering a failing step before giving up', async () => {
    const onError = vi.fn();
    const handler = vi.fn(() => Promise.reject(new Error('boom')));
    const queue = new MemoryJobQueue({ syncBroker: handler }, { maxAttempts: 2, onError });
    await queue.enqueue({ job: JOBS.syncBroker, payload: { all: true } });
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.deadLetters).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { job: 'syncBroker', payload: { all: true } });
  });

  it('dead-letters a job without a handler', async () => {
    const queue = new MemoryJobQueue();
    await queue.enqueue({ job: JOBS.refreshPrices, payload: { trigger: 'scheduled' } });
    await queue.drain();
    expect(String(queue.deadLetters[0]?.error)).toContain('No handler registered for job "refreshPrices"');
  });

  it('collects the results of finished jobs', async () => {
    const queue = new MemoryJobQueue().register(JOBS.refreshCalendar, () => Promise.resolve({ done: true, result: 42 }));
    await queue.enqueue({ job: JOBS.refreshCalendar, payload: { trigger: 'scheduled' } });
    await queue.drain();
    expect(queue.results).toEqual([{ job: 'refreshCalendar', result: 42 }]);
  });

  it('runs in the background when asked to, and keeps draining messages that arrive meanwhile', async () => {
    const queue = new MemoryJobQueue({}, { runInBackground: true });
    const seen: string[] = [];
    queue.register(JOBS.syncBroker, ({ payload }) => {
      seen.push('all' in payload ? 'all' : payload.userId);
      return Promise.resolve({ done: true, result: null });
    });
    await queue.enqueue({ job: JOBS.syncBroker, payload: { userId: 'a', portfolioId: 'p' } });
    await queue.enqueue({ job: JOBS.syncBroker, payload: { all: true } });
    await queue.drain();
    await queue.enqueue({ job: JOBS.syncBroker, payload: { userId: 'b', portfolioId: 'p' } });
    await queue.drain();
    expect(seen).toEqual(['a', 'all', 'b']);
  });

  it('starts a new run for a message that arrives right after the queue emptied', async () => {
    const queue = new MemoryJobQueue();
    const seen: number[] = [];
    queue.register(JOBS.syncBroker, () => {
      seen.push(seen.length);
      return Promise.resolve({ done: true, result: null });
    });
    await queue.enqueue({ job: JOBS.syncBroker, payload: { all: true } });
    const first = queue.drain();
    await queue.enqueue({ job: JOBS.syncBroker, payload: { all: true } });
    await first;
    await queue.drain();
    expect(seen).toEqual([0, 1]);
  });
});

describe('MemoryUsageStore', () => {
  it('lists the days that hold data, oldest first', async () => {
    const store = new MemoryUsageStore();
    await store.add('2026-10-19', { rowsRead: 1 });
    await store.add('2026-10-18', { rowsRead: 1 });
    expect(store.days).toEqual(['2026-10-18', '2026-10-19']);
  });
});
