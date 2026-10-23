import { describe, expect, it } from 'vitest';
import { MemoryItemStore } from '@portfolio/platform';
import { sampleSummary } from '@portfolio/shared';
import { EarningsRepository } from './repository.js';
import { addDays, dropUndefined, utcDayOf } from './util.js';

const NOW = new Date('2026-10-21T10:00:00.000Z');

describe('EarningsRepository', () => {
  it('stores summaries under the ticker partition, newest first, and drops undefined fields', async () => {
    const store = new MemoryItemStore();
    const repo = new EarningsRepository(store);
    await repo.putSummary(sampleSummary({ symbol: 'AAA', reportDate: '2026-01-20', quote: undefined }));
    await repo.putSummary(sampleSummary({ symbol: 'AAA', reportDate: '2026-04-20' }));
    await repo.putSummary(sampleSummary({ symbol: 'BBB', reportDate: '2026-05-20' }));
    expect((await repo.latest('AAA', 5)).map((summary) => summary.reportDate)).toEqual(['2026-04-20', '2026-01-20']);
    expect((await repo.latest('AAA', 1)).map((summary) => summary.reportDate)).toEqual(['2026-04-20']);
    expect(await repo.getSummary('AAA', '2026-01-20')).not.toHaveProperty('quote');
    expect(await repo.getSummary('AAA', '2000-01-01')).toBeNull();
    expect((await store.get({ PK: 'TICKER#AAA', SK: 'EARNSUM#2026-01-20' }))?.entityType).toBe('EARNINGS_SUMMARY');
  });

  it('prunes to the newest N', async () => {
    const repo = new EarningsRepository(new MemoryItemStore());
    for (const month of ['01', '02', '03', '04']) await repo.putSummary(sampleSummary({ symbol: 'AAA', reportDate: `2026-${month}-10` }));
    expect(await repo.prune('AAA', 2)).toBe(2);
    expect((await repo.latest('AAA', 10)).map((summary) => summary.reportDate)).toEqual(['2026-04-10', '2026-03-10']);
    expect(await repo.prune('AAA', 2)).toBe(0);
    expect(await repo.prune('NONE')).toBe(0);
  });

  it('merges state patches and removes cleared fields', async () => {
    const repo = new EarningsRepository(new MemoryItemStore());
    expect(await repo.getState('AAA')).toBeNull();
    await repo.patchState('AAA', { cik: '1', failures: 2, retryAfter: 'x' }, NOW);
    await repo.patchState('AAA', { failures: 0, retryAfter: undefined }, NOW);
    expect(await repo.getState('AAA')).toEqual({ symbol: 'AAA', cik: '1', failures: 0, updatedAt: NOW.toISOString() });
    await repo.patchState('BBB', { cik: '2' }, NOW);
    expect([...(await repo.getStates(['AAA', 'BBB', 'CCC'])).keys()].sort()).toEqual(['AAA', 'BBB']);
  });

  it('keeps the SEC block and the held cache', async () => {
    const repo = new EarningsRepository(new MemoryItemStore());
    expect(await repo.getSecBlock()).toBeNull();
    expect(await repo.getHeld()).toBeNull();
    await repo.putSecBlock({ failures: 1, updatedAt: NOW.toISOString() });
    await repo.putHeld({ builtAt: NOW.toISOString(), holdings: [{ symbol: 'AAA', name: 'A', template: 'generic' }], calendar: { AAA: ['2026-10-21'] } });
    expect(await repo.getSecBlock()).toEqual({ failures: 1, updatedAt: NOW.toISOString() });
    expect((await repo.getHeld())?.calendar).toEqual({ AAA: ['2026-10-21'] });
  });
});

describe('util', () => {
  it('drops undefined deeply, adds days and finds the UTC day', () => {
    expect(dropUndefined({ a: 1, b: undefined, c: [{ d: undefined, e: 2 }], f: null })).toEqual({ a: 1, c: [{ e: 2 }], f: null });
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(utcDayOf(new Date('2026-10-21T23:59:59.999Z'))).toBe('2026-10-21');
  });
});
