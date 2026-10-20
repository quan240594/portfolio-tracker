import { describe, expect, it } from 'vitest';
import { MemoryItemStore } from '../memory/item-store.js';
import { parseLogosConfig } from './config.js';
import { MAX_LOGO_BYTES } from './image.js';
import { ItemLogoStore, LogoTooLargeError, logoKeys } from './store.js';
import { pngBytes } from '../testing/logo-fixtures.js';

const AT = '2026-03-01T10:00:00.000Z';

describe('ItemLogoStore', () => {
  it('stores a found logo in one item under its domain and reads it back with its validator', async () => {
    const items = new MemoryItemStore();
    const store = new ItemLogoStore(items);
    const bytes = pngBytes(128, 128, 500);
    const saved = await store.putFound({ domain: 'example.com', contentType: 'image/png', bytes, source: 'google', fetchedAt: AT });
    expect(saved.etag).toMatch(/^[0-9a-f]{32}$/);
    expect(items.snapshot()).toHaveLength(1);
    expect(items.snapshot()[0]).toMatchObject({ ...logoKeys.logo('example.com'), entityType: 'LOGO', status: 'found', size: bytes.length, source: 'google' });
    expect(await store.get('example.com')).toEqual({ status: 'found', domain: 'example.com', contentType: 'image/png', bytes, etag: saved.etag, source: 'google', fetchedAt: AT });
  });

  it('gives the same bytes the same validator and other bytes another', async () => {
    const store = new ItemLogoStore(new MemoryItemStore());
    const a = await store.putFound({ domain: 'a.com', contentType: 'image/png', bytes: pngBytes(), source: 's', fetchedAt: AT });
    const b = await store.putFound({ domain: 'b.com', contentType: 'image/png', bytes: pngBytes(), source: 's', fetchedAt: AT });
    const c = await store.putFound({ domain: 'c.com', contentType: 'image/png', bytes: pngBytes(64, 64), source: 's', fetchedAt: AT });
    expect(a.etag).toBe(b.etag);
    expect(a.etag).not.toBe(c.etag);
  });

  it('stores a miss with the time it may be asked again', async () => {
    const store = new ItemLogoStore(new MemoryItemStore());
    await store.putMissing({ domain: 'nologo.example.com', checkedAt: AT, retryAfter: '2026-03-08T10:00:00.000Z' });
    expect(await store.get('nologo.example.com')).toEqual({ status: 'missing', domain: 'nologo.example.com', checkedAt: AT, retryAfter: '2026-03-08T10:00:00.000Z' });
    expect(await store.get('other.example.com')).toBeUndefined();
  });

  it('refuses more than the size cap and writes nothing', async () => {
    const items = new MemoryItemStore();
    const store = new ItemLogoStore(items);
    const atCap = new Uint8Array(MAX_LOGO_BYTES);
    await expect(store.putFound({ domain: 'cap.com', contentType: 'image/png', bytes: atCap, source: 's', fetchedAt: AT })).resolves.toMatchObject({ status: 'found' });
    await expect(store.putFound({ domain: 'big.com', contentType: 'image/png', bytes: new Uint8Array(MAX_LOGO_BYTES + 1), source: 's', fetchedAt: AT })).rejects.toBeInstanceOf(LogoTooLargeError);
    expect(items.snapshot().map((item) => item.PK)).toEqual(['LOGO#cap.com']);
  });

  it('only keys by a normalised public domain', async () => {
    const store = new ItemLogoStore(new MemoryItemStore());
    await expect(store.get('Not A Domain')).rejects.toThrow('normalised public domain');
    await expect(store.putMissing({ domain: 'localhost', checkedAt: AT, retryAfter: AT })).rejects.toThrow('normalised public domain');
  });

  it('treats an item it cannot read as absent', async () => {
    const items = new MemoryItemStore();
    await items.put({ ...logoKeys.logo('broken.com'), status: 'found', contentType: 'image/gif', data: 'AA==', etag: 'x', source: 's', fetchedAt: AT });
    await items.put({ ...logoKeys.logo('half.com'), status: 'missing' });
    const store = new ItemLogoStore(items);
    expect(await store.get('broken.com')).toBeUndefined();
    expect(await store.get('half.com')).toBeUndefined();
  });
});

describe('parseLogosConfig', () => {
  it('defaults to the three sources, 30 lookups an hour and a week of negative caching', () => {
    expect(parseLogosConfig({})).toEqual({ sources: ['logodev', 'google', 'duckduckgo'], hourlyLimit: 30, negativeTtlDays: 7 });
  });

  it('reads the list, the limits and the optional token', () => {
    expect(parseLogosConfig({ LOGO_SOURCES: ' DuckDuckGo , google, nonsense, google ', LOGO_HOURLY_LIMIT: '12', LOGO_NEGATIVE_TTL_DAYS: '30', LOGO_DEV_TOKEN: ' pk_test ' })).toEqual({
      sources: ['duckduckgo', 'google'],
      logoDevToken: 'pk_test',
      hourlyLimit: 12,
      negativeTtlDays: 30,
    });
  });

  it('switches logos off with the word off, and fetching off with a limit of 0', () => {
    expect(parseLogosConfig({ LOGO_SOURCES: 'off' }).sources).toEqual([]);
    expect(parseLogosConfig({ LOGO_HOURLY_LIMIT: '0' }).hourlyLimit).toBe(0);
  });

  it('falls back to the defaults for values out of range or not numbers', () => {
    expect(parseLogosConfig({ LOGO_HOURLY_LIMIT: '501', LOGO_NEGATIVE_TTL_DAYS: '0' })).toMatchObject({ hourlyLimit: 30, negativeTtlDays: 7 });
    expect(parseLogosConfig({ LOGO_HOURLY_LIMIT: 'lots', LOGO_NEGATIVE_TTL_DAYS: '-3' })).toMatchObject({ hourlyLimit: 30, negativeTtlDays: 7 });
    expect(parseLogosConfig({ LOGO_DEV_TOKEN: '   ' })).not.toHaveProperty('logoDevToken');
  });
});
