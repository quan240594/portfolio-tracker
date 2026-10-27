import { MemoryItemStore } from '@portfolio/platform';
import { inflationKeys } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { fakeEcb, fakeInflationPoints } from '../testing/inflation-fakes.js';
import { INFLATION_RETRY_MS, INFLATION_TTL_MS, InflationService, InflationUnavailableError } from './service.js';
import { EcbInflationSource } from './source.js';

const START = Date.parse('2026-10-01T09:00:00.000Z');

function setup() {
  const store = new MemoryItemStore();
  const ecb = fakeEcb();
  const clock = { ms: START };
  const service = new InflationService({ store, source: new EcbInflationSource({ fetch: ecb.fetch }), now: () => new Date(clock.ms) });
  return { store, ecb, clock, service };
}

describe('InflationService', () => {
  it('fetches the series once, stores it as one item and serves it from there', async () => {
    const { store, ecb, service, clock } = setup();
    const first = await service.get('U2');
    expect(first).toMatchObject({ area: 'U2', series: 'HICP.M.U2.N.000000.4D0.ANR', latestMonth: '2026-09', fetchedAt: '2026-10-01T09:00:00.000Z', stale: false });
    expect(first.points).toEqual(fakeInflationPoints('U2'));
    clock.ms += INFLATION_TTL_MS - 1;
    expect(await service.get('U2')).toEqual(first);
    expect(ecb.requests).toHaveLength(1);
    const stored = await store.get(inflationKeys.series('U2'));
    expect(stored).toMatchObject({ entityType: 'INFLATION', area: 'U2', fetchedAt: '2026-10-01T09:00:00.000Z', attemptedAt: '2026-10-01T09:00:00.000Z' });
    expect((await store.query({ pk: 'REF#INFLATION' })).items).toHaveLength(1);
  });

  it('keeps one item per area', async () => {
    const { store, ecb, service } = setup();
    await service.get('U2');
    await service.get('NL');
    expect(ecb.requests).toHaveLength(2);
    expect((await store.query({ pk: 'REF#INFLATION' })).items.map((i) => i.SK)).toEqual(['AREA#NL', 'AREA#U2']);
  });

  it('refreshes a month later: one more request and one row written', async () => {
    const { ecb, service, clock } = setup();
    await service.get('U2');
    clock.ms += INFLATION_TTL_MS;
    const second = await service.get('U2');
    expect(ecb.requests).toHaveLength(2);
    expect(second).toMatchObject({ stale: false, fetchedAt: new Date(clock.ms).toISOString() });
    await service.get('U2');
    expect(ecb.requests).toHaveLength(2);
  });

  it('serves the cached series as stale when the ECB cannot be reached, and leaves it alone for an hour', async () => {
    const { store, ecb, service, clock } = setup();
    const first = await service.get('U2');
    clock.ms += INFLATION_TTL_MS + 1000;
    ecb.failWith = 503;
    const stale = await service.get('U2');
    expect(stale).toEqual({ ...first, stale: true });
    expect(ecb.requests).toHaveLength(2);
    expect(await store.get(inflationKeys.series('U2'))).toMatchObject({ fetchedAt: first.fetchedAt, attemptedAt: new Date(clock.ms).toISOString() });
    clock.ms += INFLATION_RETRY_MS - 1;
    expect((await service.get('U2')).stale).toBe(true);
    expect(ecb.requests).toHaveLength(2);
    clock.ms += 1;
    ecb.failWith = 0;
    expect((await service.get('U2')).stale).toBe(true);
    expect(ecb.requests).toHaveLength(3);
    ecb.failWith = null;
    clock.ms += INFLATION_RETRY_MS;
    expect(await service.get('U2')).toMatchObject({ stale: false, fetchedAt: new Date(clock.ms).toISOString() });
  });

  it('fails when the ECB cannot be reached and nothing is cached', async () => {
    const { store, ecb, service } = setup();
    ecb.failWith = 0;
    await expect(service.get('U2')).rejects.toBeInstanceOf(InflationUnavailableError);
    expect(await store.get(inflationKeys.series('U2'))).toBeUndefined();
    ecb.failWith = null;
    expect((await service.get('U2')).stale).toBe(false);
  });

  it('does not store a malformed reply and ignores a cached item that is not a series', async () => {
    const { store, ecb, service } = setup();
    ecb.fetch = () => Promise.resolve(new Response('{}'));
    const broken = new InflationService({ store, source: new EcbInflationSource({ fetch: ecb.fetch }), now: () => new Date(START) });
    await expect(broken.get('U2')).rejects.toBeInstanceOf(InflationUnavailableError);
    expect(await store.get(inflationKeys.series('U2'))).toBeUndefined();
    await store.put({ ...inflationKeys.series('U2'), points: [{ month: 'x' }], area: 'U2' });
    expect((await service.get('U2')).fetchedAt).toBe('2026-10-01T09:00:00.000Z');
    await store.put({ ...inflationKeys.series('NL'), points: [], area: 'NL' });
    expect((await service.get('NL')).points.length).toBeGreaterThan(300);
    await store.put({ ...inflationKeys.series('NL'), points: fakeInflationPoints('NL'), area: 'NL', series: 's', latestMonth: 'm', fetchedAt: 5, attemptedAt: 'a' });
    expect((await service.get('NL')).fetchedAt).toBe('2026-10-01T09:00:00.000Z');
  });
});
