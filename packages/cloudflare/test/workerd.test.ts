import type { ItemStore, JobQueue, SecretStore, UsageStore } from '@portfolio/platform';
import type { FileStore, JobHandler, JobPayloads } from '@portfolio/platform';
import { runFileStoreContract, runItemStoreContract, runJobQueueContract, runSecretStoreContract, runUsageStoreContract } from '@portfolio/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '../src/file-store.js';
import { TEST_SECRETS_KEY, WorkerdHub } from './workerd-harness.js';

/**
 * The adapters in real workerd: Miniflare boots the test Worker and its SQLite-backed Durable Object (test/worker.ts) and
 * the shared contract suites drive the ports through a JSON-RPC proxy, unchanged. Coverage is measured in Node
 * (src/*.test.ts); this file proves the same behaviour on the real runtime and the real SQLite and alarm implementations.
 */
let hub: WorkerdHub;
const FIXED_START = Date.UTC(2026, 0, 5, 9); // the test Durable Object's initial clock

beforeAll(async () => {
  hub = await WorkerdHub.start();
});

afterAll(async () => {
  await hub?.dispose();
});

const items = () => hub.proxy<ItemStore>('items', 'items');
const admin = (name: string, method: string, ...args: unknown[]) => hub.call(name, 'admin', method, args);

runItemStoreContract('SqlItemStore (workerd)', () => items());

runSecretStoreContract('SqlSecretStore (workerd)', () => hub.proxy<SecretStore>('secrets', 'secrets'));

runUsageStoreContract('SqlUsageStore (workerd)', () => hub.proxy<UsageStore>('usage', 'usage'));

runFileStoreContract('SqlFileStore (workerd)', () => ({
  store: hub.proxy<FileStore>('files', 'files'),
  upload: async (target, content) => {
    const { status, text } = await hub.put(target.url, target.headers, content);
    if (status !== 204) throw new Error(`Upload failed: ${status} ${text}`);
  },
}));

let jobHubs = 0;
runJobQueueContract('AlarmJobQueue (workerd)', () => {
  const name = `jobs-${++jobHubs}`;
  let now = FIXED_START;
  return {
    queue: hub.proxy<JobQueue>(name, 'jobs'),
    register: (handler: JobHandler<JobPayloads['syncBroker']>) => hub.register(name, 'syncBroker', handler as JobHandler<never>),
    drain: async function drain(round = 0): Promise<void> {
      if (round >= 50) throw new Error('The queue did not drain');
      await admin(name, 'runAlarm');
      const due = (await admin(name, 'nextJobDueAt')) as number | null;
      if (due === null) return;
      now = Math.max(now, due);
      await admin(name, 'setNow', now);
      await drain(round + 1);
    },
  };
});

describe('workerd specifics', () => {
  it('sorts sort keys in UTF-8 byte order in the real SQLite (an astral character after U+FFFF)', async () => {
    const store = items();
    await store.batchWrite(['k#\u{1f600}', 'k#\uffff', 'k#z', 'k#é', 'k#A'].map((SK) => ({ type: 'put' as const, item: { PK: 'collation', SK } })));
    const page = await store.query({ pk: 'collation', sk: { beginsWith: 'k#' } });
    expect(page.items.map((item) => item.SK)).toEqual(['k#A', 'k#z', 'k#é', 'k#\uffff', 'k#\u{1f600}']);
  });

  it('reports the rows the real storage counts, and a query reads only the page it returns', async () => {
    const store = items();
    const usage = async () => (await admin('items', 'usage')) as { rowsRead: number; rowsWritten: number };
    await store.batchWrite(Array.from({ length: 60 }, (_, i) => ({ type: 'put' as const, item: { PK: 'usage', SK: `K#${String(i).padStart(3, '0')}`, i } })));

    await admin('items', 'resetUsage');
    await store.batchWrite(Array.from({ length: 25 }, (_, i) => ({ type: 'put' as const, item: { PK: 'usage', SK: `W#${String(i).padStart(3, '0')}` } })));
    expect((await usage()).rowsWritten).toBe(25); // one written row per item: no index

    await admin('items', 'resetUsage');
    await store.get({ PK: 'usage', SK: 'K#007' });
    expect(await usage()).toEqual({ rowsRead: 1, rowsWritten: 0 });

    await admin('items', 'resetUsage');
    const page = await store.query({ pk: 'usage', sk: { beginsWith: 'K#' }, limit: 5 });
    expect(page.items).toHaveLength(5);
    expect((await usage()).rowsRead).toBeLessThanOrEqual(6); // the page and one look-ahead row, not the 60 of the partition
  });

  it('keeps secrets encrypted at rest and unreadable with another key', async () => {
    const secrets = hub.proxy<SecretStore>('secrets', 'secrets');
    await secrets.put('workerd-broker', '{"apiKey":"sk-live-0123456789"}');
    const [row] = (await admin('secrets', 'sql', 'SELECT value FROM secrets WHERE name = ?', 'workerd-broker')) as { value: string }[];
    expect(row!.value).toMatch(/^v1\./);
    expect(row!.value).not.toContain('sk-live');
    expect(await admin('secrets', 'secretsWithKey', TEST_SECRETS_KEY, 'get', 'workerd-broker')).toBe('{"apiKey":"sk-live-0123456789"}');
    await expect(admin('secrets', 'secretsWithKey', btoa('2'.repeat(32)), 'get', 'workerd-broker')).rejects.toThrow(/could not be decrypted/);
  });

  it('stores a file of the largest size in the real SQLite and refuses one byte more', async () => {
    const files = hub.proxy<FileStore>('files', 'files');
    const send = async (key: string, size: number) => {
      const target = await files.createUpload({ key, contentType: 'text/csv', expiresInSeconds: 300 });
      return hub.put(target.url, target.headers, 'x'.repeat(size));
    };
    expect(await send('workerd/max.csv', MAX_FILE_BYTES + 1)).toMatchObject({ status: 413 });
    expect(await send('workerd/max.csv', MAX_FILE_BYTES)).toMatchObject({ status: 204 });
    expect(await files.readText('workerd/max.csv', MAX_FILE_BYTES)).toMatchObject({ ok: true });
    expect(await files.readText('workerd/max.csv', 1024)).toMatchObject({ ok: false, reason: expect.stringContaining('too large') as string });
    await files.delete('workerd/max.csv');
  });

  it('rejects an upload with an unknown token', async () => {
    expect(await hub.put('https://app.test/api/uploads/not-a-token', {}, 'x')).toMatchObject({ status: 404 });
  });

  it('arms the real Durable Object alarm for the earliest job', async () => {
    const name = 'alarm-armed';
    // Far in the future, so the alarm stays armed (an alarm in the past fires at once).
    const start = Date.UTC(2100, 0, 1);
    await admin(name, 'setNow', start);
    const queue = hub.proxy<JobQueue>(name, 'jobs');
    await queue.enqueue({ job: 'syncBroker', payload: { all: true }, delayMs: 90_000 });
    await queue.enqueue({ job: 'syncBroker', payload: { all: true }, delayMs: 30_000 });
    expect(await admin(name, 'getAlarm')).toBe(start + 30_000);
  });

  it('runs a job from the alarm the platform fires by itself', async () => {
    const name = 'alarm-real';
    const ran = new Promise<unknown>((resolve) => {
      hub.register(name, 'syncBroker', (invocation) => {
        resolve(invocation);
        return Promise.resolve({ done: true, result: 'ok' });
      });
    });
    await admin(name, 'useRealClock');
    await hub.proxy<JobQueue>(name, 'jobs').enqueue({ job: 'syncBroker', payload: { all: true }, delayMs: 50 });
    expect(await ran).toEqual({ payload: { all: true } });
    await expect.poll(() => admin(name, 'nextJobDueAt'), { timeout: 10_000 }).toBeNull();
  });
});
