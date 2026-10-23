import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CLASSIFICATION_ROUTES, type ClassificationImportResponse, type ClassificationInstrument } from '@portfolio/shared';
import { createHandler } from './lambda/handler.js';
import { matchRoute } from './router.js';
import { ItemManagementRepository } from './management-repository.js';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';
import { MemoryItemStore } from '@portfolio/platform';
import { loadProfiles } from './lib/profiles.js';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);
const NOW = '2026-06-15T12:00:00.000Z';

/** AAA (US stock, provider profile), FUND.MI (ETF with a Trading 212 baseline profile), NOPR.AS (no profile yet), SOLD (closed). */
function setup() {
  const ctx = fakeDeps();
  const { repo } = ctx;
  repo.portfolios = [portfolio({ portfolioId: 'default', name: 'Main' }), portfolio({ portfolioId: 'default', userId: 'other', name: 'Other' })];
  repo.transactions = [
    txn({ id: 't1', date: '2025-01-10', type: 'BUY', symbol: 'AAA', quantity: 10, price: 100, currency: 'USD' }),
    txn({ id: 't2', date: '2025-01-11', type: 'BUY', symbol: 'FUND.MI', quantity: 10, price: 100 }),
    txn({ id: 't3', date: '2025-01-12', type: 'BUY', symbol: 'NOPR.AS', quantity: 1, price: 50 }),
    txn({ id: 't4', date: '2025-01-13', type: 'BUY', symbol: 'SOLD', quantity: 1, price: 50 }),
    txn({ id: 't5', date: '2025-02-13', type: 'SELL', symbol: 'SOLD', quantity: 1, price: 60 }),
    txn({ id: 'o1', userId: 'other', date: '2025-01-10', type: 'BUY', symbol: 'ZZZ', quantity: 1, price: 10 }),
  ];
  repo.quotes = {
    AAA: { symbol: 'AAA', price: 110, previousClose: 108, currency: 'USD', asOf: NOW, source: 'test' },
    'FUND.MI': { symbol: 'FUND.MI', price: 120, previousClose: 118, currency: 'EUR', asOf: NOW, source: 'test' },
    'NOPR.AS': { symbol: 'NOPR.AS', price: 55, previousClose: 54, currency: 'EUR', asOf: NOW, source: 'test' },
  };
  repo.profiles = {
    AAA: { symbol: 'AAA', name: 'Aaa Inc', assetClass: 'STOCK', currency: 'USD', sector: 'Technology', country: 'United States', isin: 'US0000000002', profileSource: 'provider' },
    'FUND.MI': { symbol: 'FUND.MI', name: 'Invented World Fund', assetClass: 'ETF', currency: 'EUR', isin: 'IE00INVENT01', country: 'Ireland', profileSource: 'trading212' },
  };
  repo.fx = { base: 'EUR', rates: { USD: 1.1 }, asOf: NOW };
  const handler = createHandler(() => ctx.deps);
  const call = async (method: string, path: string, opts: { query?: Record<string, string>; body?: unknown; sub?: string } = {}) => {
    const res = await handler(apiEvent(method, path, opts));
    return { status: res.statusCode, body: json(res) };
  };
  return { ...ctx, call };
}

const put = (s: ReturnType<typeof setup>, symbol: string, body: unknown) => s.call('PUT', `/classification/${encodeURIComponent(symbol)}`, { body });
const instrumentOf = (body: { instruments: ClassificationInstrument[] }, symbol: string) => body.instruments.find((i) => i.symbol === symbol)!;

describe('routing', () => {
  it('matches every classification route', () => {
    for (const [name, spec] of Object.entries(CLASSIFICATION_ROUTES)) {
      const [method, path] = spec.split(' ') as [string, string];
      expect(matchRoute(method, path.replace('{symbol}', 'FWRA.MI')).name).toBe(name);
    }
  });
});

describe('GET /classification', () => {
  it('lists the held symbols with the stored profile as base, sorted, without closed positions or other users', async () => {
    const { status, body } = await setup().call('GET', '/classification');
    expect(status).toBe(200);
    expect(body.instruments.map((i: ClassificationInstrument) => i.symbol)).toEqual(['AAA', 'FUND.MI', 'NOPR.AS']);
    expect(instrumentOf(body, 'AAA')).toEqual({
      symbol: 'AAA',
      effective: { name: 'Aaa Inc', assetClass: 'STOCK', sector: 'Technology', country: 'United States' },
      base: { name: 'Aaa Inc', assetClass: 'STOCK', sector: 'Technology', country: 'United States' },
      source: 'provider',
      isin: 'US0000000002',
      currency: 'USD',
      override: null,
      held: true,
      updatedAt: null,
    });
    expect(instrumentOf(body, 'FUND.MI')).toMatchObject({ source: 'trading212', base: { sector: null, country: 'Ireland' } });
    expect(instrumentOf(body, 'NOPR.AS')).toMatchObject({ source: 'none', isin: null, currency: null, base: { name: 'NOPR.AS', assetClass: 'OTHER' } });
  });
});

describe('PUT and DELETE /classification/{symbol}', () => {
  it('stores an override that wins over the profile and answers the instrument', async () => {
    const s = setup();
    const { status, body } = await put(s, 'fund.mi', { name: 'My World Fund', sector: 'Diversified', country: 'World' });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      symbol: 'FUND.MI',
      effective: { name: 'My World Fund', assetClass: 'ETF', sector: 'Diversified', country: 'World' },
      base: { name: 'Invented World Fund', sector: null, country: 'Ireland' },
      override: { name: 'My World Fund', sector: 'Diversified', country: 'World' },
      updatedAt: NOW,
    });
    expect(s.mgmt.overrides).toEqual([{ userId: 'demo', symbol: 'FUND.MI', name: 'My World Fund', sector: 'Diversified', country: 'World', createdAt: NOW, updatedAt: NOW }]);
  });

  it('stores the website domain of the logo normalised, keeps it out of the allocation values and refuses one that is not a public host', async () => {
    const s = setup();
    const { status, body } = await put(s, 'AAA', { domain: 'https://www.Aaa-Inc.example.com/about' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ symbol: 'AAA', effective: { name: 'Aaa Inc', sector: 'Technology' }, override: { domain: 'aaa-inc.example.com' } });
    expect(s.mgmt.overrides).toEqual([{ userId: 'demo', symbol: 'AAA', domain: 'aaa-inc.example.com', createdAt: NOW, updatedAt: NOW }]);
    const profiles = await loadProfiles({ deps: s.deps, userId: 'demo' } as never, ['AAA']);
    expect(profiles.AAA).toEqual(s.repo.profiles.AAA);
    expect((await put(s, 'AAA', { domain: 'localhost' })).status).toBe(400);
    expect((await put(s, 'AAA', { domain: '192.168.0.1' })).status).toBe(400);
  });

  it('stores the earnings KPI template, keeps it out of the allocation values and refuses an unknown one', async () => {
    const s = setup();
    const { status, body } = await put(s, 'AAA', { kpiTemplate: 'saas' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ symbol: 'AAA', effective: { name: 'Aaa Inc', sector: 'Technology' }, override: { kpiTemplate: 'saas' } });
    expect(s.mgmt.overrides).toEqual([{ userId: 'demo', symbol: 'AAA', kpiTemplate: 'saas', createdAt: NOW, updatedAt: NOW }]);
    const profiles = await loadProfiles({ deps: s.deps, userId: 'demo' } as never, ['AAA']);
    expect(profiles.AAA).toEqual(s.repo.profiles.AAA);
    expect((await put(s, 'AAA', { kpiTemplate: 'crypto' })).status).toBe(400);
    expect((await put(s, 'AAA', {})).status).toBe(400);
  });

  it('is applied by holdings, allocation and asset detail, and removed again by DELETE', async () => {
    const s = setup();
    const before = await s.call('GET', '/allocation', { query: { by: 'assetClass' } });
    expect(before.body.slices.map((slice: { key: string }) => slice.key).sort()).toEqual(['ETF', 'OTHER', 'STOCK']);
    await put(s, 'NOPR.AS', { name: 'No profile Co', assetClass: 'COMMODITY', sector: 'Commodities', country: 'Netherlands' });
    const holdings = await s.call('GET', '/holdings');
    expect(holdings.body.holdings.find((h: { symbol: string }) => h.symbol === 'NOPR.AS')).toMatchObject({ name: 'No profile Co', assetClass: 'COMMODITY', sector: 'Commodities', country: 'Netherlands' });
    expect(holdings.body.holdings.find((h: { symbol: string }) => h.symbol === 'AAA')).toMatchObject({ name: 'Aaa Inc', assetClass: 'STOCK' });
    const after = await s.call('GET', '/allocation', { query: { by: 'assetClass' } });
    expect(after.body.slices.map((slice: { key: string }) => slice.key)).toContain('COMMODITY');
    const bySector = await s.call('GET', '/allocation', { query: { by: 'sector' } });
    expect(bySector.body.slices.map((slice: { key: string }) => slice.key)).toContain('Commodities');
    const detail = await s.call('GET', '/assets/AAA');
    expect(detail.body.profile).toMatchObject({ name: 'Aaa Inc' });
    await put(s, 'AAA', { name: 'My Aaa' });
    expect((await s.call('GET', '/assets/AAA')).body.profile).toMatchObject({ name: 'My Aaa', sector: 'Technology' });
    expect((await s.call('GET', '/securities/closed')).status).toBe(200);

    expect((await s.call('DELETE', '/classification/NOPR.AS')).status).toBe(204);
    expect((await s.call('DELETE', '/classification/NOPR.AS')).status).toBe(204);
    const restored = await s.call('GET', '/holdings');
    expect(restored.body.holdings.find((h: { symbol: string }) => h.symbol === 'NOPR.AS')).toMatchObject({ name: 'NOPR.AS', assetClass: 'OTHER' });
  });

  it('keeps the creation time when an override is changed and lists overrides of symbols that are no longer held', async () => {
    const s = setup();
    await put(s, 'GONE', { sector: 'Energy' });
    const first = s.mgmt.overrides[0]!;
    expect(first).toMatchObject({ symbol: 'GONE', createdAt: NOW });
    s.deps.now = () => new Date('2026-06-16T08:00:00.000Z');
    const changed = await put(s, 'GONE', { sector: 'Utilities' });
    expect(changed.body).toMatchObject({ held: false, source: 'none', effective: { sector: 'Utilities' }, updatedAt: '2026-06-16T08:00:00.000Z' });
    expect(s.mgmt.overrides[0]).toMatchObject({ createdAt: NOW, updatedAt: '2026-06-16T08:00:00.000Z', sector: 'Utilities' });
    expect((await s.call('GET', '/classification')).body.instruments.map((i: ClassificationInstrument) => i.symbol)).toContain('GONE');
  });

  it('never shows or changes another user\'s overrides', async () => {
    const s = setup();
    await s.call('PUT', '/classification/AAA', { body: { name: 'Mine' }, sub: 'other' });
    expect(s.mgmt.overrides).toEqual([expect.objectContaining({ userId: 'other', symbol: 'AAA' })]);
    expect(instrumentOf((await s.call('GET', '/classification')).body, 'AAA').override).toBeNull();
    expect((await s.call('GET', '/holdings')).body.holdings.find((h: { symbol: string }) => h.symbol === 'AAA').name).toBe('Aaa Inc');
  });

  it('validates the symbol and the body before storing anything', async () => {
    const s = setup();
    expect((await put(s, 'AAA', {})).status).toBe(400);
    expect((await put(s, 'AAA', { assetClass: 'WIDGET' })).status).toBe(400);
    expect((await put(s, 'AAA', { name: '' })).status).toBe(400);
    expect((await put(s, 'AAA', { name: 'x', userId: 'someone' })).status).toBe(400);
    expect((await s.call('PUT', '/classification/AAA')).status).toBe(400);
    expect((await put(s, 'CUSTOM:abc', { name: 'x' })).status).toBe(400);
    expect((await s.call('DELETE', '/classification/CASH.EUR')).status).toBe(400);
    expect(s.mgmt.overrides).toEqual([]);
  });
});

describe('POST /classification/import', () => {
  const rows = [
    { ticker: 'AAA', isin: 'US0000000002', name: 'Aaa Incorporated', assetClass: 'STOCK', sector: 'Technology', country: 'United States' },
    { ticker: 'FUND', isin: 'IE00INVENT01', currency: 'EUR', assetClass: 'ETF', sector: 'Diversified', country: 'Other' },
    { ticker: 'NOPR', assetClass: 'COMMODITY', sector: 'Commodities' },
    { ticker: 'NOPE', sector: 'Energy' },
    { ticker: 'SOLD', sector: 'Energy' },
    { ticker: 'AAA', sector: 'Energy' },
    { ticker: 'ZZZ', sector: 'Energy' },
  ];

  it('previews without storing: matches by ISIN then ticker and reports what it cannot match', async () => {
    const s = setup();
    const { status, body } = await s.call('POST', '/classification/import', { body: { dryRun: true, rows } });
    const result = body as ClassificationImportResponse;
    expect(status).toBe(200);
    expect(result).toMatchObject({ dryRun: true, applied: 0 });
    expect(result.matched.map((m) => [m.index, m.symbol, m.matchedBy])).toEqual([[0, 'AAA', 'isin'], [1, 'FUND.MI', 'isin'], [2, 'NOPR.AS', 'ticker']]);
    expect(result.matched[0]!.changes).toEqual([{ field: 'name', from: 'Aaa Inc', to: 'Aaa Incorporated' }]);
    expect(result.matched[1]!.changes).toEqual([{ field: 'sector', from: null, to: 'Diversified' }, { field: 'country', from: 'Ireland', to: 'Other' }]);
    expect(result.unmatched.map((u) => [u.index, u.ticker, u.reason])).toEqual([[3, 'NOPE', 'not-held'], [4, 'SOLD', 'not-held'], [5, 'AAA', 'duplicate'], [6, 'ZZZ', 'not-held']]);
    expect(s.mgmt.overrides).toEqual([]);
  });

  it('stores the matched rows, merges with an existing override and is idempotent', async () => {
    const s = setup();
    await put(s, 'AAA', { sector: 'Pinned sector' });
    const applied = await s.call('POST', '/classification/import', { body: { rows } });
    expect(applied.body).toMatchObject({ dryRun: false, applied: 3 });
    expect(s.mgmt.overrides.map((o) => o.symbol)).toEqual(['AAA', 'FUND.MI', 'NOPR.AS']);
    expect(s.mgmt.overrides.find((o) => o.symbol === 'AAA')).toMatchObject({ name: 'Aaa Incorporated', sector: 'Technology', assetClass: 'STOCK', country: 'United States' });
    expect(s.mgmt.overrides.find((o) => o.symbol === 'NOPR.AS')).toEqual({ userId: 'demo', symbol: 'NOPR.AS', assetClass: 'COMMODITY', sector: 'Commodities', createdAt: NOW, updatedAt: NOW });
    const again = await s.call('POST', '/classification/import', { body: { rows } });
    expect(again.body).toMatchObject({ applied: 0 });
    expect((await s.call('GET', '/holdings')).body.holdings.find((h: { symbol: string }) => h.symbol === 'NOPR.AS')).toMatchObject({ assetClass: 'COMMODITY' });
  });

  it('rejects an invalid or oversized import', async () => {
    const s = setup();
    expect((await s.call('POST', '/classification/import', { body: { rows: [] } })).status).toBe(400);
    expect((await s.call('POST', '/classification/import', { body: { rows: [{ ticker: 'A', isin: 'bad' }] } })).status).toBe(400);
    expect((await s.call('POST', '/classification/import', { body: { rows: [{ ticker: 'A', sector: 'x'.repeat(40), name: 'y'.repeat(1_100_000) }] } })).body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(s.mgmt.overrides).toEqual([]);
  });
});

describe('ItemManagementRepository classification items', () => {
  it('stores overrides under USER#/CLASS# and reads them back by symbol and as a list', async () => {
    const store = new MemoryItemStore();
    const repo = new ItemManagementRepository(store);
    const item = { userId: 'u1', symbol: 'FWRA.MI', name: 'N', createdAt: NOW, updatedAt: NOW };
    await repo.putClassificationOverrides([item, { ...item, symbol: 'AAA', sector: 'Energy' }]);
    expect(store.snapshot().map((i) => [i.PK, i.SK, i.entityType])).toEqual([
      ['USER#u1', 'CLASS#FWRA.MI', 'CLASSIFICATION'],
      ['USER#u1', 'CLASS#AAA', 'CLASSIFICATION'],
    ]);
    expect(await repo.getClassificationOverrides('u1', ['AAA', 'NOPE'])).toEqual({ AAA: { ...item, symbol: 'AAA', sector: 'Energy' } });
    expect(await repo.getClassificationOverrides('u1', [])).toEqual({});
    expect((await repo.listClassificationOverrides('u1')).map((o) => o.symbol)).toEqual(['AAA', 'FWRA.MI']);
    expect(await repo.listClassificationOverrides('u2')).toEqual([]);
    await repo.deleteClassificationOverride('u1', 'AAA');
    expect((await repo.listClassificationOverrides('u1')).map((o) => o.symbol)).toEqual(['FWRA.MI']);
  });
});

describe('GET /export/backup', () => {
  it('includes the overrides', async () => {
    const s = setup();
    await put(s, 'AAA', { name: 'Mine' });
    const backup = await s.call('GET', '/export/backup');
    expect(backup.status).toBe(200);
    expect(backup.body.classificationOverrides).toEqual([expect.objectContaining({ symbol: 'AAA', name: 'Mine' })]);
  });
});

describe('loadProfiles', () => {
  it('reads nothing for no symbols and applies overrides for the rest', async () => {
    const s = setup();
    const ctx = { deps: s.deps, userId: 'demo', pathParams: {}, query: {} };
    expect(await loadProfiles(ctx, [])).toEqual({});
    await s.mgmt.putClassificationOverrides([{ userId: 'demo', symbol: 'AAA', sector: 'Energy', createdAt: NOW, updatedAt: NOW }]);
    expect((await loadProfiles(ctx, ['AAA', 'AAA', 'FUND.MI']))['AAA']).toMatchObject({ name: 'Aaa Inc', sector: 'Energy' });
  });
});
