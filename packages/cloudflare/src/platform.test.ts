import { JOBS } from '@portfolio/platform';
import { describe, expect, it } from 'vitest';
import { SqlJsStorage, TestClock } from '../test/sqljs-storage.js';
import { uploadTokenFromUrl } from './file-store.js';
import { createDurableObjectPlatform, type DurableObjectPlatformOptions } from './platform.js';
import { generateSecretsKey } from './secret-store.js';
import type { SqlUsage } from './sql.js';

const setup = async (options: Partial<DurableObjectPlatformOptions> = {}) => {
  const storage = await SqlJsStorage.create();
  const clock = new TestClock();
  const platform = createDurableObjectPlatform({ ctx: { storage }, secretsKey: generateSecretsKey(), now: clock.now, ...options });
  return { storage, clock, platform };
};

describe('createDurableObjectPlatform', () => {
  it('builds every adapter on one storage', async () => {
    const { storage, platform } = await setup({ uploadBaseUrl: 'https://tracker.test', schedules: [] });
    await platform.items.put({ PK: 'p', SK: 's', v: 1 });
    await platform.secrets.put('broker', 'secret value');
    await platform.jobs.enqueue({ job: JOBS.syncBroker, payload: { all: true } });
    const target = await platform.files.createUpload({ key: 'imports/a.csv', contentType: 'text/csv', expiresInSeconds: 60 });
    expect(await platform.items.get({ PK: 'p', SK: 's' })).toEqual({ PK: 'p', SK: 's', v: 1 });
    expect(await platform.secrets.get('broker')).toBe('secret value');
    expect(target.url.startsWith('https://tracker.test/api/uploads/')).toBe(true);
    const tables = storage.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);
    expect(tables).toEqual(['files', 'items', 'jobs', 'schedules', 'secrets', 'uploads', 'usage']);
  });

  it('reports the rows every adapter reads and writes to onUsage', async () => {
    const usage: SqlUsage[] = [];
    const { platform } = await setup({ uploadBaseUrl: 'https://tracker.test', schedules: [], onUsage: (delta) => usage.push(delta) });
    const total = () => usage.reduce((sum, delta) => sum + delta.rowsWritten, 0);
    const written = async (step: () => Promise<unknown>) => {
      const before = total();
      await step();
      return total() - before;
    };
    expect(await written(() => platform.items.put({ PK: 'p', SK: 's' }))).toBe(1);
    expect(await written(() => platform.secrets.put('a', 'b'))).toBe(1);
    expect(await written(() => platform.jobs.enqueue({ job: JOBS.syncBroker, payload: { all: true } }))).toBe(1);
    expect(await written(() => platform.files.createUpload({ key: 'k', contentType: 'text/csv', expiresInSeconds: 60 }))).toBe(1);
    expect(usage.some((delta) => delta.rowsRead > 0)).toBe(false);
    await platform.items.get({ PK: 'p', SK: 's' });
    expect(usage.some((delta) => delta.rowsRead > 0)).toBe(true);
  });

  it('serves the upload flow of the Worker: createUpload, acceptUpload with the token, readText', async () => {
    const { platform } = await setup({ schedules: [] });
    platform.setUploadBaseUrl('https://first.test');
    platform.setUploadBaseUrl('https://second.test');
    const target = await platform.files.createUpload({ key: 'imports/u/i.csv', contentType: 'text/csv', expiresInSeconds: 60 });
    expect(target.url.startsWith('https://second.test/api/uploads/')).toBe(true);
    const result = await platform.acceptUpload(uploadTokenFromUrl(target.url)!, new TextEncoder().encode('a,b'));
    expect(result).toEqual({ ok: true, key: 'imports/u/i.csv', size: 3 });
    expect(await platform.files.readText('imports/u/i.csv', 100)).toEqual({ ok: true, content: 'a,b' });
  });

  it('refuses to create an upload while the base URL is unknown', async () => {
    const { platform } = await setup({ schedules: [] });
    await expect(platform.files.createUpload({ key: 'k', contentType: 'text/csv', expiresInSeconds: 60 })).rejects.toThrow(/upload base URL is not set/);
  });

  it('accepts a base URL function', async () => {
    let origin = 'https://a.test';
    const { platform } = await setup({ schedules: [], uploadBaseUrl: () => origin });
    origin = 'https://b.test';
    expect((await platform.files.createUpload({ key: 'k', contentType: 'text/csv', expiresInSeconds: 60 })).url.startsWith('https://b.test/')).toBe(true);
  });

  it('arms the alarm for the shared cron schedules and runs due jobs through the bound runAlarm', async () => {
    const { platform, storage, clock } = await setup();
    const next = await platform.arm();
    expect(next).toBe(Date.UTC(2026, 0, 5, 12)); // 13:00 in Amsterdam
    expect(storage.alarm).toBe(next);
    await platform.jobs.enqueue({ job: JOBS.syncBroker, payload: { all: true } });
    const calls: unknown[] = [];
    const report = await platform.runAlarm({
      syncBroker: (invocation) => {
        calls.push(invocation.payload);
        return Promise.resolve({ done: true, result: null });
      },
    });
    expect(calls).toEqual([{ all: true }]);
    expect(report).toMatchObject({ steps: 1, completed: 1, nextAlarm: next });
    expect(clock.ms).toBe(Date.UTC(2026, 0, 5, 9));
  });

  it('uses the real clock and random ids when none are injected', async () => {
    const storage = await SqlJsStorage.create();
    const platform = createDurableObjectPlatform({ ctx: { storage }, secretsKey: generateSecretsKey(), schedules: [], uploadBaseUrl: 'https://x.test' });
    await platform.jobs.enqueue({ job: JOBS.syncBroker, payload: { all: true } });
    expect(await platform.runAlarm({ syncBroker: () => Promise.resolve({ done: true, result: null }) })).toMatchObject({ completed: 1 });
    const target = await platform.files.createUpload({ key: 'k', contentType: 'text/csv', expiresInSeconds: 60 });
    expect((await platform.acceptUpload(uploadTokenFromUrl(target.url)!, new Uint8Array(1))).ok).toBe(true);
  });

  it('rejects a bad secrets key when the Durable Object starts', async () => {
    const storage = await SqlJsStorage.create();
    expect(() => createDurableObjectPlatform({ ctx: { storage }, secretsKey: 'short' })).toThrow();
  });
});
