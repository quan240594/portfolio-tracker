import { describe, expect, it, vi } from 'vitest';
import { createStepContext } from './common.js';
import { createRefreshPricesJob } from './refresh-prices.js';
import { REPAIR_ROWS_PER_STEP, initialRepair, runMinorUnitRepair } from './repair-minor-units.js';
import { NOW, drive, harness, liveFake, track } from '../testing/harness.js';

const MARKER = { PK: 'USAGE', SK: 'REPAIR#minor-units-v1' };
const eod = (symbol: string, n: number, close: number, currency: string) => ({ PK: `TICKER#${symbol}`, SK: `EOD#${String(n).padStart(6, '0')}`, entityType: 'EOD', symbol, date: String(n), close, currency });
const rows = (symbol: string, count: number, currency: string) => Array.from({ length: count }, (_, n) => eod(symbol, n, 5000 + n, currency));

describe('the one-time minor-unit repair step', () => {
  it('repairs every symbol, then sets the marker once with the rows read and written', async () => {
    const h = harness();
    h.store.load([...rows('VOD.L', 3, 'GBX'), ...rows('AAPL', 2, 'USD')]);
    const ctx = createStepContext(h.deps);
    const repair = initialRepair();

    expect(await runMinorUnitRepair(ctx, repair, ['AAPL', 'VOD.L'], NOW)).toBe(true);
    expect(repair).toEqual({ queue: [], failed: 0, rows: { read: 5, written: 3 } });
    expect(await h.store.get(MARKER)).toMatchObject({ doneAt: NOW.toISOString(), read: 5, written: 3 });
    expect(await h.store.get({ PK: 'TICKER#VOD.L', SK: 'EOD#000002' })).toMatchObject({ close: 50.02, currency: 'GBP' });
  });

  it('does nothing at all once the marker is set (one read, no query, no write)', async () => {
    const h = harness();
    h.store.load([{ ...MARKER, entityType: 'ENRICH_STATE', doneAt: 'x' }, ...rows('VOD.L', 3, 'GBX')]);
    const query = vi.spyOn(h.store, 'query');
    const batchWrite = vi.spyOn(h.store, 'batchWrite');
    const repair = initialRepair();
    expect(await runMinorUnitRepair(createStepContext(h.deps), repair, ['VOD.L'], NOW)).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(batchWrite).not.toHaveBeenCalled();
    expect(repair.queue).toBeNull();
    expect(await h.store.get({ PK: 'TICKER#VOD.L', SK: 'EOD#000001' })).toMatchObject({ currency: 'GBX' });
  });

  it('is chunked by rows read: a step stops taking symbols once it has read the budget, the next one continues', async () => {
    const h = harness();
    const per = REPAIR_ROWS_PER_STEP / 2 + 1;
    h.store.load(['A.L', 'B.L', 'C.L'].flatMap((symbol) => rows(symbol, per, 'GBX')));
    const ctx = createStepContext(h.deps);
    const repair = initialRepair();
    const symbols = ['A.L', 'B.L', 'C.L'];

    expect(await runMinorUnitRepair(ctx, repair, symbols, NOW)).toBe(false);
    expect(repair.queue).toEqual(['C.L']);
    expect(await h.store.get(MARKER)).toBeUndefined();
    expect(await runMinorUnitRepair(ctx, repair, symbols, NOW)).toBe(true);
    expect(repair.rows).toEqual({ read: 3 * per, written: 3 * per });
    expect(await h.store.get(MARKER)).toMatchObject({ read: 3 * per, written: 3 * per });
  });

  it('always takes at least one symbol, however many rows it has', async () => {
    const h = harness();
    h.store.load(rows('BIG.L', REPAIR_ROWS_PER_STEP + 10, 'GBX'));
    const repair = initialRepair();
    expect(await runMinorUnitRepair(createStepContext(h.deps), repair, ['BIG.L', 'NEXT.L'], NOW)).toBe(false);
    expect(repair.queue).toEqual(['NEXT.L']);
  });

  it('does not set the marker when a symbol failed, and a later run repairs it (it cannot loop: the queue only shrinks)', async () => {
    const h = harness();
    h.store.load([...rows('A.L', 2, 'GBX'), ...rows('B.L', 2, 'GBX')]);
    const batchWrite = vi.spyOn(h.store, 'batchWrite').mockRejectedValueOnce(new Error('disk full'));
    const repair = initialRepair();
    expect(await runMinorUnitRepair(createStepContext(h.deps), repair, ['A.L', 'B.L'], NOW)).toBe(true);
    expect(repair.failed).toBe(1);
    expect(repair.queue).toEqual([]);
    expect(await h.store.get(MARKER)).toBeUndefined();

    batchWrite.mockRestore();
    const next = initialRepair();
    expect(await runMinorUnitRepair(createStepContext(h.deps), next, ['A.L', 'B.L'], NOW)).toBe(true);
    expect(next).toMatchObject({ failed: 0, rows: { read: 4, written: 2 } });
    expect(await h.store.get(MARKER)).toBeDefined();
  });

  it('survives a marker that cannot be written: the pass is simply repeated by a later refresh', async () => {
    const h = harness();
    h.store.load(rows('A.L', 1, 'GBX'));
    vi.spyOn(h.store, 'put').mockRejectedValue(new Error('no'));
    expect(await runMinorUnitRepair(createStepContext(h.deps), initialRepair(), ['A.L'], NOW)).toBe(true);
    expect(await h.store.get(MARKER)).toBeUndefined();
  });

  it('is safe when the alarm fires twice at once: both finish, the rows are right, the marker is there', async () => {
    const h = harness();
    h.store.load([...rows('A.L', 4, 'GBX'), ...rows('B.L', 4, 'GBp')]);
    const results = await Promise.all([
      runMinorUnitRepair(createStepContext(h.deps), initialRepair(), ['A.L', 'B.L'], NOW),
      runMinorUnitRepair(createStepContext(h.deps), initialRepair(), ['A.L', 'B.L'], NOW),
    ]);
    expect(results).toEqual([true, true]);
    const eods = h.store.snapshot().filter((item) => item.SK.startsWith('EOD#'));
    expect(eods.every((item) => item.currency === 'GBP' && Number(item.close) < 100)).toBe(true);
    expect(await h.store.get(MARKER)).toBeDefined();
  });
});

describe('the repair inside refreshPrices', () => {
  const quote = { PK: 'TICKER#VOD.L', SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol: 'VOD.L', price: 7260, previousClose: 7250, currency: 'GBX', asOf: '2026-10-12T16:00:00.000Z', source: 'old' };

  it('runs after the other phases, repairs stored rows once and leaves them alone on the next refresh', async () => {
    const h = harness({ fake: liveFake() });
    track(h.store, 'AAPL', 'VOD.L');
    h.store.load([eod('VOD.L', 1, 7250, 'GBX'), eod('VOD.L', 2, 7260, 'GBX'), quote]);
    const job = createRefreshPricesJob(h.deps);

    await drive(h, job, { trigger: 'scheduled' });
    expect(await h.store.get({ PK: 'TICKER#VOD.L', SK: 'EOD#000001' })).toMatchObject({ close: 72.5, currency: 'GBP' });
    expect(await h.store.get({ PK: 'TICKER#VOD.L', SK: 'QUOTE#LATEST' })).toMatchObject({ price: 72.6, currency: 'GBP' });
    const marker = await h.store.get(MARKER);
    expect(marker).toMatchObject({ written: 3 });

    h.store.load([eod('VOD.L', 3, 7300, 'GBX')]);
    await drive(h, job, { trigger: 'scheduled' });
    expect(await h.store.get(MARKER)).toEqual(marker);
    expect(await h.store.get({ PK: 'TICKER#VOD.L', SK: 'EOD#000003' })).toMatchObject({ close: 7300, currency: 'GBX' });
  });

  it('continues a cursor stored by an earlier version (no repair field) in the repair phase', async () => {
    const h = harness({ fake: liveFake() });
    h.store.load([eod('VOD.L', 1, 7250, 'GBX')]);
    const cursor = JSON.stringify({
      v: 1,
      now: NOW.toISOString(),
      phase: 'details',
      symbols: ['VOD.L'],
      fx: { ok: true, latest: null },
      history: { ranges: [], written: 0, ok: true, lastDay: null, final: true },
      euWindow: true,
      skipped: [],
      failed: {},
      refreshed: [],
      batches: [],
      readyAt: {},
      detailQueue: [],
      detailsRefreshed: 0,
    });
    const step = await createRefreshPricesJob(h.deps)({ payload: { trigger: 'scheduled' }, cursor });
    expect(step.done).toBe(true);
    expect(await h.store.get({ PK: 'TICKER#VOD.L', SK: 'EOD#000001' })).toMatchObject({ close: 72.5, currency: 'GBP' });
  });

  it('spreads a repair over steps when the rows exceed a step budget, and the steps agree when delivered twice', async () => {
    const h = harness({ fake: liveFake() });
    const per = REPAIR_ROWS_PER_STEP / 2 + 1;
    track(h.store, 'A.L', 'B.L', 'C.L');
    h.store.load(['A.L', 'B.L', 'C.L'].flatMap((symbol) => rows(symbol, per, 'GBX')));
    const { steps } = await drive(h, createRefreshPricesJob(h.deps), { trigger: 'scheduled' });
    expect(steps.filter((step) => !step.done).length).toBeGreaterThanOrEqual(1);
    expect(await h.store.get(MARKER)).toMatchObject({ written: 3 * per });
  });
});
