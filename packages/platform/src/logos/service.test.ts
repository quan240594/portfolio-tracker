import { describe, expect, it, vi } from 'vitest';
import { MemoryItemStore } from '../memory/item-store.js';
import { pngBytes } from '../testing/logo-fixtures.js';
import { LogoService, type LogoServiceOptions } from './service.js';
import type { LogoFailure, LogoFetchResult, LogoSource } from './sources.js';
import { ItemLogoStore } from './store.js';

const START = new Date('2026-03-01T10:20:00.000Z');

function source(name: string, answer: LogoFailure | 'found', calls: string[] = []): LogoSource {
  return {
    name,
    fetchLogo: (domain): Promise<LogoFetchResult> => {
      calls.push(`${name}:${domain}`);
      return Promise.resolve(answer === 'found' ? { ok: true, source: name, logo: { bytes: pngBytes(), contentType: 'image/png', width: 128, height: 128 } } : { ok: false, source: name, reason: answer });
    },
  };
}

function setup(sources: LogoSource[], extra: Partial<LogoServiceOptions> = {}) {
  let now = START.getTime();
  const items = new MemoryItemStore();
  const service = new LogoService({ store: new ItemLogoStore(items), sources, now: () => new Date(now), hourlyLimit: 30, negativeTtlDays: 7, fetch: vi.fn() as unknown as typeof fetch, ...extra });
  return { service, items, advance: (ms: number) => (now += ms) };
}

describe('LogoService', () => {
  it('fetches a logo once, stores it, and serves it from the store afterwards', async () => {
    const calls: string[] = [];
    const { service, items } = setup([source('google', 'found', calls)]);
    const first = await service.lookup('example.com');
    expect(first).toMatchObject({ kind: 'found', logo: { source: 'google', contentType: 'image/png', fetchedAt: START.toISOString() } });
    expect(await service.lookup('example.com')).toMatchObject({ kind: 'found' });
    expect(calls).toEqual(['google:example.com']);
    expect(items.snapshot()).toHaveLength(1);
  });

  it('tries the sources in order and stops at the first one that has a logo', async () => {
    const calls: string[] = [];
    const { service } = setup([source('a', 'not-found', calls), source('b', 'too-small', calls), source('c', 'found', calls), source('d', 'found', calls)]);
    expect(await service.lookup('example.com')).toMatchObject({ kind: 'found', logo: { source: 'c' } });
    expect(calls).toEqual(['a:example.com', 'b:example.com', 'c:example.com']);
  });

  it('remembers that nobody had a logo for a week and then asks again', async () => {
    const calls: string[] = [];
    const { service, items, advance } = setup([source('a', 'not-found', calls), source('b', 'placeholder', calls)]);
    expect(await service.lookup('none.example.com')).toEqual({ kind: 'missing', reason: 'no-logo' });
    expect(await service.lookup('none.example.com')).toEqual({ kind: 'missing', reason: 'cached' });
    expect(calls).toHaveLength(2);
    expect(items.snapshot()[0]).toMatchObject({ status: 'missing', retryAfter: '2026-03-08T10:20:00.000Z' });
    advance(7 * 86_400_000 - 1);
    expect(await service.lookup('none.example.com')).toEqual({ kind: 'missing', reason: 'cached' });
    advance(2);
    expect(await service.lookup('none.example.com')).toEqual({ kind: 'missing', reason: 'no-logo' });
    expect(calls).toHaveLength(4);
  });

  it('remembers a transient failure for an hour only', async () => {
    const calls: string[] = [];
    const { service, advance } = setup([source('a', 'timeout', calls), source('b', 'not-found', calls)]);
    expect(await service.lookup('flaky.example.com')).toEqual({ kind: 'missing', reason: 'no-logo' });
    advance(3_599_000);
    expect(await service.lookup('flaky.example.com')).toEqual({ kind: 'missing', reason: 'cached' });
    advance(2000);
    await service.lookup('flaky.example.com');
    expect(calls).toHaveLength(4);
  });

  it('does not look anything up with no source switched on or a limit of 0, but still serves stored logos', async () => {
    const { service, items } = setup([]);
    expect(await service.lookup('example.com')).toEqual({ kind: 'missing', reason: 'disabled' });
    expect(items.snapshot()).toEqual([]);
    const zero = setup([source('a', 'found')], { hourlyLimit: 0 });
    expect(await zero.service.lookup('example.com')).toEqual({ kind: 'missing', reason: 'disabled' });
    await new ItemLogoStore(zero.items).putFound({ domain: 'stored.com', contentType: 'image/png', bytes: pngBytes(), source: 'x', fetchedAt: START.toISOString() });
    expect(await zero.service.lookup('stored.com')).toMatchObject({ kind: 'found' });
  });

  it('allows at most the hourly number of lookups and says when the hour ends', async () => {
    const calls: string[] = [];
    const { service, advance } = setup([source('a', 'found', calls)], { hourlyLimit: 2 });
    await service.lookup('one.example.com');
    await service.lookup('two.example.com');
    // 10:20 -> the next hour starts in 40 minutes.
    expect(await service.lookup('three.example.com')).toEqual({ kind: 'limited', retryAfterSeconds: 2400 });
    // A stored logo does not count against the limit.
    expect(await service.lookup('one.example.com')).toMatchObject({ kind: 'found' });
    expect(calls).toHaveLength(2);
    advance(2400_000);
    expect(await service.lookup('three.example.com')).toMatchObject({ kind: 'found' });
    expect(calls).toHaveLength(3);
  });

  it('does not count a refused lookup and refuses while the usage budget is busy', async () => {
    let allowed = false;
    const calls: string[] = [];
    const { service } = setup([source('a', 'found', calls)], { hourlyLimit: 1, allowFetch: () => Promise.resolve(allowed) });
    expect(await service.lookup('example.com')).toEqual({ kind: 'limited', retryAfterSeconds: 600 });
    expect(calls).toEqual([]);
    allowed = true;
    expect(await service.lookup('example.com')).toMatchObject({ kind: 'found' });
  });

  it('shares one lookup between concurrent requests for a domain, one domain at a time otherwise', async () => {
    const calls: string[] = [];
    const { service } = setup([source('a', 'found', calls)]);
    const results = await Promise.all([service.lookup('ishares.com'), service.lookup('ishares.com'), service.lookup('ishares.com')]);
    expect(results.every((result) => result.kind === 'found')).toBe(true);
    expect(calls).toEqual(['a:ishares.com']);
  });

  it('gives the sources the fetch of the lookup, its own or the default one', async () => {
    const seen: unknown[] = [];
    const spy: LogoSource = {
      name: 'spy',
      fetchLogo: (_domain, fetchOptions) => {
        seen.push(fetchOptions.fetch);
        return Promise.resolve({ ok: false, source: 'spy', reason: 'not-found' });
      },
    };
    const own = vi.fn() as unknown as typeof fetch;
    const { service } = setup([spy]);
    await service.lookup('a.example.com', own);
    expect(seen[0]).toBe(own);
    const bare = new LogoService({ store: new ItemLogoStore(new MemoryItemStore()), sources: [spy], now: () => START, hourlyLimit: 5, negativeTtlDays: 1 });
    await bare.lookup('b.example.com');
    expect(typeof seen[1]).toBe('function');
    expect(seen[1]).not.toBe(own);
  });
});
