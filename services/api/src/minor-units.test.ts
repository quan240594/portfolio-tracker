import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { MemoryItemStore } from '@portfolio/platform';
import { ENTITY, keys } from '@portfolio/shared';
import { createHandler } from './lambda/handler.js';
import { ItemRepository } from './repository.js';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);

/** Today is 2026-06-15 (fakeDeps); GBP costs 0.8 per euro. */
const POUNDS_PER_EURO = 0.8;

/**
 * A London ETF (10 units, bought at 30 pounds) whose EOD rows, quote and dividend were stored in pence and labelled GBX by an
 * earlier version, on the real repository over a memory store: every consumer must see pounds.
 */
async function setup() {
  const store = new MemoryItemStore();
  const repo = new ItemRepository(store);
  const ctx = fakeDeps({ repo });
  await repo.createPortfolio(portfolio({ portfolioId: 'default', name: 'Main portfolio' }));
  await repo.putTransaction(txn({ id: 't1', date: '2025-06-15', type: 'BUY', symbol: 'SMGB.L', quantity: 10, price: 30, currency: 'GBP' }));
  const pence: [string, number][] = [['2025-06-15', 3000], ['2025-12-15', 3300], ['2026-06-12', 3500], ['2026-06-15', 3600]];
  await store.batchWrite([
    ...pence.map(([date, close]) => ({ type: 'put' as const, item: { ...keys.eod('SMGB.L', date), entityType: ENTITY.eod, symbol: 'SMGB.L', date, close, currency: 'GBX' } })),
    ...pence.map(([date, close]) => ({ type: 'put' as const, item: { ...keys.eod('IUKP.L', date), entityType: ENTITY.eod, symbol: 'IUKP.L', date, close: close / 2, currency: 'GBp' } })),
    { type: 'put' as const, item: { ...keys.quote('SMGB.L'), entityType: ENTITY.quote, symbol: 'SMGB.L', price: 3600, previousClose: 3500, currency: 'GBX', asOf: '2026-06-15T16:00:00Z', source: 'eodhd-eod' } },
    { type: 'put' as const, item: { ...keys.profile('SMGB.L'), entityType: ENTITY.profile, symbol: 'SMGB.L', name: 'London ETF', assetClass: 'ETF', currency: 'GBP' } },
    { type: 'put' as const, item: { ...keys.dividendEvent('SMGB.L', '2026-07-01'), entityType: ENTITY.dividendEvent, symbol: 'SMGB.L', exDate: '2026-07-01', amount: 50, currency: 'GBX' } },
    { type: 'put' as const, item: { ...keys.fx('EUR'), entityType: ENTITY.fx, base: 'EUR', rates: { GBP: POUNDS_PER_EURO }, asOf: '2026-06-15T00:00:00Z' } },
  ]);
  return { handler: createHandler(() => ctx.deps), store };
}

describe('stored minor-unit prices are read in major units', () => {
  it('values the portfolio history in pounds: 10 units at 36 pounds, not 3,600 pence each', async () => {
    const { handler } = await setup();
    const res = await handler(apiEvent('GET', '/history', { query: { range: '1Y' } }));
    expect(res.statusCode).toBe(200);
    const points = json(res).points as { date: string; value: number; invested: number }[];
    expect(points.at(-1)).toMatchObject({ date: '2026-06-15', value: 450, invested: 375 });
    expect(Math.max(...points.map((point) => point.value))).toBeLessThan(500);
  });

  it('values the holdings from a stored GBX quote', async () => {
    const { handler } = await setup();
    const body = json(await handler(apiEvent('GET', '/holdings')));
    expect(body.holdings[0]).toMatchObject({ symbol: 'SMGB.L', priceLocal: 36, marketValue: 450 });
  });

  it('shows the asset price, the day change and the benchmark series in pounds', async () => {
    const { handler } = await setup();
    const asset = json(await handler(apiEvent('GET', '/assets/SMGB.L')));
    expect(asset.quote).toMatchObject({ price: 36, currency: 'GBP' });
    const history = json(await handler(apiEvent('GET', '/assets/SMGB.L/history', { query: { range: '1Y', benchmarks: 'IUKP.L' } })));
    expect(history.points.at(-1)).toMatchObject({ close: 36 });
    expect(history.benchmarks[0].points.at(-1)).toEqual({ value: 18, returnPct: 20 });
  });

  it('reads the upcoming dividend in pounds', async () => {
    const { handler } = await setup();
    const body = json(await handler(apiEvent('GET', '/dividends')));
    expect(body.upcoming[0]).toMatchObject({ symbol: 'SMGB.L', perShareLocal: 0.5, currency: 'GBP' });
  });

  it('leaves the stored items as they are (the repair job rewrites them, reads never write)', async () => {
    const { handler, store } = await setup();
    await handler(apiEvent('GET', '/history', { query: { range: '1Y' } }));
    expect(await store.get(keys.eod('SMGB.L', '2026-06-15'))).toMatchObject({ close: 3600, currency: 'GBX' });
  });
});
