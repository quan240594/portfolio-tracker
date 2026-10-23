import { describe, expect, it } from 'vitest';
import { MemoryItemStore } from '../memory/item-store.js';
import { parseLogosConfig } from './config.js';
import { MAX_LOGO_BYTES } from './image.js';
import { DEFAULT_T212_LOGO_BASE } from './sources.js';
import { ItemLogoStore, LOGO_SCHEMA_VERSION, LogoTooLargeError, logoKeys, t212LogoKey } from './store.js';
import { pngBytes } from '../testing/logo-fixtures.js';

const AT = '2026-03-01T10:00:00.000Z';

describe('ItemLogoStore', () => {
  it('stores a found logo in one item under its domain and reads it back with its validator', async () => {
    const items = new MemoryItemStore();
    const store = new ItemLogoStore(items);
    const bytes = pngBytes(128, 128, 500);
    const saved = await store.putFound({ key: 'example.com', contentType: 'image/png', bytes, source: 'google', fetchedAt: AT });
    expect(saved.etag).toMatch(/^v2-google-[0-9a-f]{32}$/);
    expect(items.snapshot()).toHaveLength(1);
    expect(items.snapshot()[0]).toMatchObject({ ...logoKeys.logo('example.com'), entityType: 'LOGO', v: LOGO_SCHEMA_VERSION, status: 'found', size: bytes.length, source: 'google' });
    expect(await store.get('example.com')).toEqual({ status: 'found', key: 'example.com', contentType: 'image/png', bytes, etag: saved.etag, source: 'google', fetchedAt: AT });
  });

  it('gives the same bytes the same validator and other bytes another', async () => {
    const store = new ItemLogoStore(new MemoryItemStore());
    const a = await store.putFound({ key: 'a.com', contentType: 'image/png', bytes: pngBytes(), source: 's', fetchedAt: AT });
    const b = await store.putFound({ key: 'b.com', contentType: 'image/png', bytes: pngBytes(), source: 's', fetchedAt: AT });
    const c = await store.putFound({ key: 'c.com', contentType: 'image/png', bytes: pngBytes(64, 64), source: 's', fetchedAt: AT });
    expect(a.etag).toBe(b.etag);
    expect(a.etag).not.toBe(c.etag);
  });

  it('puts the source and the schema version in the validator, so a better source for the same bytes revalidates', async () => {
    const store = new ItemLogoStore(new MemoryItemStore());
    const google = await store.putFound({ key: 'a.com', contentType: 'image/png', bytes: pngBytes(), source: 'google', fetchedAt: AT });
    const t212 = await store.putFound({ key: 'a.com', contentType: 'image/png', bytes: pngBytes(), source: 't212', fetchedAt: AT });
    expect(google.etag).not.toBe(t212.etag);
    expect(t212.etag).toMatch(/^v2-t212-/);
  });

  it('stores a Trading 212 logo under t212:<ticker>', async () => {
    const items = new MemoryItemStore();
    const store = new ItemLogoStore(items);
    await store.putFound({ key: t212LogoKey('SMGBl_EQ'), contentType: 'image/png', bytes: pngBytes(240, 240), source: 't212', fetchedAt: AT });
    expect(items.snapshot()[0]).toMatchObject({ PK: 'LOGO#t212:SMGBl_EQ', SK: 'LOGO' });
    expect(await store.get('t212:SMGBl_EQ')).toMatchObject({ status: 'found', key: 't212:SMGBl_EQ', source: 't212' });
  });

  it('ignores items of another schema version, found or missing, and overwrites them', async () => {
    const items = new MemoryItemStore();
    const store = new ItemLogoStore(items);
    const found = { entityType: 'LOGO', status: 'found', contentType: 'image/png', data: 'AA==', etag: 'abc', source: 'google', fetchedAt: AT };
    await items.put({ ...logoKeys.logo('v1.com'), ...found });
    await items.put({ ...logoKeys.logo('v1.com'), ...found, v: 1 });
    await items.put({ ...logoKeys.logo('v1miss.com'), entityType: 'LOGO', status: 'missing', checkedAt: AT, retryAfter: '2099-01-01T00:00:00.000Z' });
    expect(await store.get('v1.com')).toBeUndefined();
    expect(await store.get('v1miss.com')).toBeUndefined();
    await store.putFound({ key: 'v1.com', contentType: 'image/png', bytes: pngBytes(), source: 't212', fetchedAt: AT });
    expect(await store.get('v1.com')).toMatchObject({ status: 'found', source: 't212' });
    expect(items.snapshot().filter((item) => item.PK === 'LOGO#v1.com')).toHaveLength(1);
  });

  it('stores a miss with the time it may be asked again', async () => {
    const store = new ItemLogoStore(new MemoryItemStore());
    await store.putMissing({ key: 'nologo.example.com', checkedAt: AT, retryAfter: '2026-03-08T10:00:00.000Z' });
    expect(await store.get('nologo.example.com')).toEqual({ status: 'missing', key: 'nologo.example.com', checkedAt: AT, retryAfter: '2026-03-08T10:00:00.000Z' });
    expect(await store.get('other.example.com')).toBeUndefined();
  });

  it('refuses more than the size cap and writes nothing', async () => {
    const items = new MemoryItemStore();
    const store = new ItemLogoStore(items);
    const atCap = new Uint8Array(MAX_LOGO_BYTES);
    await expect(store.putFound({ key: 'cap.com', contentType: 'image/png', bytes: atCap, source: 's', fetchedAt: AT })).resolves.toMatchObject({ status: 'found' });
    await expect(store.putFound({ key: 'big.com', contentType: 'image/png', bytes: new Uint8Array(MAX_LOGO_BYTES + 1), source: 's', fetchedAt: AT })).rejects.toBeInstanceOf(LogoTooLargeError);
    expect(items.snapshot().map((item) => item.PK)).toEqual(['LOGO#cap.com']);
  });

  it('only keys by a normalised public domain or a valid Trading 212 ticker', async () => {
    const store = new ItemLogoStore(new MemoryItemStore());
    await expect(store.get('Not A Domain')).rejects.toThrow('normalised public domain');
    await expect(store.putMissing({ key: 'localhost', checkedAt: AT, retryAfter: AT })).rejects.toThrow('normalised public domain');
    await expect(store.get('t212:../x')).rejects.toThrow('Trading 212 ticker');
    await expect(store.get('t212:')).rejects.toThrow('Trading 212 ticker');
  });

  it('treats an item it cannot read as absent', async () => {
    const items = new MemoryItemStore();
    await items.put({ ...logoKeys.logo('broken.com'), v: LOGO_SCHEMA_VERSION, status: 'found', contentType: 'image/gif', data: 'AA==', etag: 'x', source: 's', fetchedAt: AT });
    await items.put({ ...logoKeys.logo('half.com'), v: LOGO_SCHEMA_VERSION, status: 'missing' });
    const store = new ItemLogoStore(items);
    expect(await store.get('broken.com')).toBeUndefined();
    expect(await store.get('half.com')).toBeUndefined();
  });
});

describe('parseLogosConfig', () => {
  it('defaults to the four sources (the Trading 212 bucket first), 30 lookups an hour and a week of negative caching', () => {
    expect(parseLogosConfig({})).toEqual({ sources: ['t212', 'logodev', 'google', 'duckduckgo'], t212Base: DEFAULT_T212_LOGO_BASE, allowAnyHost: false, hourlyLimit: 30, negativeTtlDays: 7 });
  });

  it('can switch the Trading 212 source off by leaving it out of the list', () => {
    expect(parseLogosConfig({ LOGO_SOURCES: 'google,duckduckgo' }).sources).toEqual(['google', 'duckduckgo']);
    expect(parseLogosConfig({ LOGO_SOURCES: 't212' }).sources).toEqual(['t212']);
  });

  it('reads the bucket override only when it is a safe origin, the any-host test flag included', () => {
    expect(parseLogosConfig({ LOGO_T212_BASE: 'https://other.s3.eu-west-1.amazonaws.com' }).t212Base).toBe('https://other.s3.eu-west-1.amazonaws.com');
    expect(parseLogosConfig({ LOGO_T212_BASE: 'https://evil.example.com' }).t212Base).toBe(DEFAULT_T212_LOGO_BASE);
    expect(parseLogosConfig({ LOGO_T212_BASE: 'http://localhost:9000' }).t212Base).toBe(DEFAULT_T212_LOGO_BASE);
    expect(parseLogosConfig({ LOGO_T212_BASE: 'http://localhost:9000', LOGO_ALLOW_ANY_HOST: '1' })).toMatchObject({ t212Base: 'http://localhost:9000', allowAnyHost: true });
    expect(parseLogosConfig({ LOGO_ALLOW_ANY_HOST: 'true' }).allowAnyHost).toBe(false);
  });

  it('reads the list, the limits and the optional token', () => {
    expect(parseLogosConfig({ LOGO_SOURCES: ' DuckDuckGo , google, nonsense, google ', LOGO_HOURLY_LIMIT: '12', LOGO_NEGATIVE_TTL_DAYS: '30', LOGO_DEV_TOKEN: ' pk_test ' })).toEqual({
      sources: ['duckduckgo', 'google'],
      logoDevToken: 'pk_test',
      t212Base: DEFAULT_T212_LOGO_BASE,
      allowAnyHost: false,
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
