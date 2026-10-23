import { describe, expect, it, vi } from 'vitest';
import { MemoryItemStore } from '../memory/item-store.js';
import { pngBytes } from '../testing/logo-fixtures.js';
import { LogoService, type LogoServiceOptions } from './service.js';
import type { LogoFailure, LogoFetchResult, LogoSource } from './sources.js';
import { ItemLogoStore, LOGO_SCHEMA_VERSION, logoKeys, t212LogoKey } from './store.js';

const START = new Date('2026-03-01T10:20:00.000Z');

function source(name: string, answer: LogoFailure | 'found', calls: string[] = [], by: LogoSource['by'] = 'domain'): LogoSource {
  return {
    name,
    by,
    fetchLogo: (subject): Promise<LogoFetchResult> => {
      calls.push(`${name}:${subject[by]}`);
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
    const first = await service.lookup({ domain: 'example.com' });
    expect(first).toMatchObject({ kind: 'found', logo: { source: 'google', contentType: 'image/png', fetchedAt: START.toISOString() } });
    expect(await service.lookup({ domain: 'example.com' })).toMatchObject({ kind: 'found' });
    expect(calls).toEqual(['google:example.com']);
    expect(items.snapshot()).toHaveLength(1);
  });

  it('tries the sources in order and stops at the first one that has a logo', async () => {
    const calls: string[] = [];
    const { service } = setup([source('a', 'not-found', calls), source('b', 'too-small', calls), source('c', 'found', calls), source('d', 'found', calls)]);
    expect(await service.lookup({ domain: 'example.com' })).toMatchObject({ kind: 'found', logo: { source: 'c' } });
    expect(calls).toEqual(['a:example.com', 'b:example.com', 'c:example.com']);
  });

  it('remembers that nobody had a logo for a week and then asks again', async () => {
    const calls: string[] = [];
    const { service, items, advance } = setup([source('a', 'not-found', calls), source('b', 'placeholder', calls)]);
    expect(await service.lookup({ domain: 'none.example.com' })).toEqual({ kind: 'missing', reason: 'no-logo' });
    expect(await service.lookup({ domain: 'none.example.com' })).toEqual({ kind: 'missing', reason: 'cached' });
    expect(calls).toHaveLength(2);
    expect(items.snapshot()[0]).toMatchObject({ status: 'missing', retryAfter: '2026-03-08T10:20:00.000Z' });
    advance(7 * 86_400_000 - 1);
    expect(await service.lookup({ domain: 'none.example.com' })).toEqual({ kind: 'missing', reason: 'cached' });
    advance(2);
    expect(await service.lookup({ domain: 'none.example.com' })).toEqual({ kind: 'missing', reason: 'no-logo' });
    expect(calls).toHaveLength(4);
  });

  it('remembers a transient failure for an hour only', async () => {
    const calls: string[] = [];
    const { service, advance } = setup([source('a', 'timeout', calls), source('b', 'not-found', calls)]);
    expect(await service.lookup({ domain: 'flaky.example.com' })).toEqual({ kind: 'missing', reason: 'no-logo' });
    advance(3_599_000);
    expect(await service.lookup({ domain: 'flaky.example.com' })).toEqual({ kind: 'missing', reason: 'cached' });
    advance(2000);
    await service.lookup({ domain: 'flaky.example.com' });
    expect(calls).toHaveLength(4);
  });

  it('does not look anything up with no source switched on or a limit of 0, but still serves stored logos', async () => {
    const { service, items } = setup([]);
    expect(await service.lookup({ domain: 'example.com' })).toEqual({ kind: 'missing', reason: 'disabled' });
    expect(items.snapshot()).toEqual([]);
    const zero = setup([source('a', 'found')], { hourlyLimit: 0 });
    expect(await zero.service.lookup({ domain: 'example.com' })).toEqual({ kind: 'missing', reason: 'disabled' });
    await new ItemLogoStore(zero.items).putFound({ key: 'stored.com', contentType: 'image/png', bytes: pngBytes(), source: 'a', fetchedAt: START.toISOString() });
    expect(await zero.service.lookup({ domain: 'stored.com' })).toMatchObject({ kind: 'found' });
  });

  it('allows at most the hourly number of lookups and says when the hour ends', async () => {
    const calls: string[] = [];
    const { service, advance } = setup([source('a', 'found', calls)], { hourlyLimit: 2 });
    await service.lookup({ domain: 'one.example.com' });
    await service.lookup({ domain: 'two.example.com' });
    // 10:20 -> the next hour starts in 40 minutes.
    expect(await service.lookup({ domain: 'three.example.com' })).toEqual({ kind: 'limited', retryAfterSeconds: 2400 });
    // A stored logo does not count against the limit.
    expect(await service.lookup({ domain: 'one.example.com' })).toMatchObject({ kind: 'found' });
    expect(calls).toHaveLength(2);
    advance(2400_000);
    expect(await service.lookup({ domain: 'three.example.com' })).toMatchObject({ kind: 'found' });
    expect(calls).toHaveLength(3);
  });

  it('does not count a refused lookup and refuses while the usage budget is busy', async () => {
    let allowed = false;
    const calls: string[] = [];
    const { service } = setup([source('a', 'found', calls)], { hourlyLimit: 1, allowFetch: () => Promise.resolve(allowed) });
    expect(await service.lookup({ domain: 'example.com' })).toEqual({ kind: 'limited', retryAfterSeconds: 600 });
    expect(calls).toEqual([]);
    allowed = true;
    expect(await service.lookup({ domain: 'example.com' })).toMatchObject({ kind: 'found' });
  });

  it('shares one lookup between concurrent requests for a domain, one domain at a time otherwise', async () => {
    const calls: string[] = [];
    const { service } = setup([source('a', 'found', calls)]);
    const results = await Promise.all([service.lookup({ domain: 'ishares.com' }), service.lookup({ domain: 'ishares.com' }), service.lookup({ domain: 'ishares.com' })]);
    expect(results.every((result) => result.kind === 'found')).toBe(true);
    expect(calls).toEqual(['a:ishares.com']);
  });

  it('gives the sources the fetch of the lookup, its own or the default one', async () => {
    const seen: unknown[] = [];
    const spy: LogoSource = {
      name: 'spy',
      by: 'domain',
      fetchLogo: (_subject, fetchOptions) => {
        seen.push(fetchOptions.fetch);
        return Promise.resolve({ ok: false, source: 'spy', reason: 'not-found' });
      },
    };
    const own = vi.fn() as unknown as typeof fetch;
    const { service } = setup([spy]);
    await service.lookup({ domain: 'a.example.com' }, own);
    expect(seen[0]).toBe(own);
    const bare = new LogoService({ store: new ItemLogoStore(new MemoryItemStore()), sources: [spy], now: () => START, hourlyLimit: 5, negativeTtlDays: 1 });
    await bare.lookup({ domain: 'b.example.com' });
    expect(typeof seen[1]).toBe('function');
    expect(seen[1]).not.toBe(own);
  });

  describe('by Trading 212 ticker', () => {
    const subject = { t212Ticker: 'KMB_US_EQ', domain: 'kimberly-clark.com' };

    it('asks the ticker source first and stores the logo under the ticker, one row', async () => {
      const calls: string[] = [];
      const { service, items } = setup([source('t212', 'found', calls, 't212Ticker'), source('google', 'found', calls)]);
      expect(await service.lookup(subject)).toMatchObject({ kind: 'found', logo: { key: 't212:KMB_US_EQ', source: 't212' } });
      expect(await service.lookup(subject)).toMatchObject({ kind: 'found' });
      expect(calls).toEqual(['t212:KMB_US_EQ']);
      expect(items.snapshot()).toHaveLength(1);
      expect(items.snapshot()[0]).toMatchObject({ ...logoKeys.logo(t212LogoKey('KMB_US_EQ')), v: LOGO_SCHEMA_VERSION, source: 't212' });
    });

    it('falls back to the domain sources when the bucket has no logo, still one row under the ticker', async () => {
      const calls: string[] = [];
      const { service, items } = setup([source('t212', 'not-found', calls, 't212Ticker'), source('google', 'found', calls)]);
      expect(await service.lookup(subject)).toMatchObject({ kind: 'found', logo: { key: 't212:KMB_US_EQ', source: 'google' } });
      expect(calls).toEqual(['t212:KMB_US_EQ', 'google:kimberly-clark.com']);
      expect(items.snapshot()).toHaveLength(1);
    });

    it('ends with the monogram (a cached miss) when no source has it', async () => {
      const calls: string[] = [];
      const { service } = setup([source('t212', 'not-found', calls, 't212Ticker'), source('google', 'too-small', calls)]);
      expect(await service.lookup(subject)).toEqual({ kind: 'missing', reason: 'no-logo' });
      expect(await service.lookup(subject)).toEqual({ kind: 'missing', reason: 'cached' });
      expect(calls).toHaveLength(2);
    });

    it('serves a symbol without a ticker from the domain sources only, stored under the domain', async () => {
      const calls: string[] = [];
      const { service } = setup([source('t212', 'found', calls, 't212Ticker'), source('google', 'found', calls)]);
      expect(await service.lookup({ domain: 'example.com' })).toMatchObject({ kind: 'found', logo: { key: 'example.com', source: 'google' } });
      expect(calls).toEqual(['google:example.com']);
    });

    it('does not ask a domain source for a symbol that has only a ticker', async () => {
      const calls: string[] = [];
      const { service } = setup([source('t212', 'not-found', calls, 't212Ticker'), source('google', 'found', calls)]);
      expect(await service.lookup({ t212Ticker: 'ZZZ_US_EQ' })).toEqual({ kind: 'missing', reason: 'no-logo' });
      expect(calls).toEqual(['t212:ZZZ_US_EQ']);
    });

    it('uses the domain key when the ticker source is switched off, and has nothing for a ticker-only symbol', async () => {
      const calls: string[] = [];
      const { service } = setup([source('google', 'found', calls)]);
      expect(await service.lookup(subject)).toMatchObject({ kind: 'found', logo: { key: 'kimberly-clark.com' } });
      expect(await service.lookup({ t212Ticker: 'ZZZ_US_EQ' })).toEqual({ kind: 'missing', reason: 'no-logo' });
      expect(await service.lookup({})).toEqual({ kind: 'missing', reason: 'no-logo' });
      const onlyTicker = setup([source('t212', 'found', calls, 't212Ticker')]);
      expect(await onlyTicker.service.lookup({ domain: 'example.com' })).toEqual({ kind: 'missing', reason: 'no-logo' });
      expect(calls).toEqual(['google:kimberly-clark.com']);
    });

    it('ignores a ticker that is not valid', async () => {
      const { service } = setup([source('t212', 'found', [], 't212Ticker')]);
      expect(await service.lookup({ t212Ticker: '../x' })).toEqual({ kind: 'missing', reason: 'no-logo' });
    });
  });

  describe('old results', () => {
    it('ignores a logo or a miss stored before the schema version and fetches again once', async () => {
      const calls: string[] = [];
      const { service, items } = setup([source('t212', 'found', calls)]);
      const old = { entityType: 'LOGO', status: 'found', contentType: 'image/png', data: 'AA==', etag: 'abc', source: 'google', fetchedAt: '2026-01-01T00:00:00.000Z' };
      await items.put({ ...logoKeys.logo('example.com'), ...old });
      await items.put({ ...logoKeys.logo('nope.com'), entityType: 'LOGO', status: 'missing', checkedAt: START.toISOString(), retryAfter: '2099-01-01T00:00:00.000Z' });
      expect(await service.lookup({ domain: 'example.com' })).toMatchObject({ kind: 'found', logo: { source: 't212' } });
      expect(await service.lookup({ domain: 'nope.com' })).toMatchObject({ kind: 'found' });
      expect(await service.lookup({ domain: 'example.com' })).toMatchObject({ kind: 'found' });
      expect(calls).toEqual(['t212:example.com', 't212:nope.com']);
      expect(items.snapshot().every((item) => item.v === LOGO_SCHEMA_VERSION)).toBe(true);
    });

    it('does not serve a stored logo of a source that is switched off', async () => {
      const calls: string[] = [];
      const first = setup([source('t212', 'found', calls, 't212Ticker')]);
      await first.service.lookup({ t212Ticker: 'AAA_US_EQ' });
      const second = new LogoService({ store: new ItemLogoStore(first.items), sources: [source('google', 'found', calls)], now: () => START, hourlyLimit: 30, negativeTtlDays: 7 });
      expect(await second.lookup({ t212Ticker: 'AAA_US_EQ', domain: 'a.example.com' })).toMatchObject({ kind: 'found', logo: { source: 'google' } });
      expect(calls).toEqual(['t212:AAA_US_EQ', 'google:a.example.com']);
    });
  });
});
