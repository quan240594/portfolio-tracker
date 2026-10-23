import { queryAll } from '@portfolio/platform';
import { keys } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { Browser } from './browser.js';
import { AV_KEY, EODHD_KEY, LONDON_PENCE, TD_KEY, londonPenceCloses } from './fakes.js';
import { T0, createNodeStack } from './node-stack.js';

const SYMBOL = 'SMGB.L';
const REPAIR_MARKER = { PK: 'USAGE', SK: 'REPAIR#minor-units-v1' };

/** Prices stored before the providers rescaled at the source: what the live deployment holds for a London ETF. */
describe('Node: minor-unit prices already stored by an earlier version', () => {
  async function started() {
    const stack = await createNodeStack({ prices: { TWELVEDATA_API_KEY: TD_KEY, ALPHAVANTAGE_API_KEY: AV_KEY, EODHD_API_KEY: EODHD_KEY, FX_HISTORY_START: '2026-01-01' } });
    const owner = new Browser(stack);
    await owner.signIn();
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await owner.request(`/api${path}`, { method, ...(body === undefined ? {} : { body }) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const portfolio = (await call('POST', '/portfolios', { name: 'London' })).body.portfolioId as string;
    await call('POST', '/transactions', { portfolioId: portfolio, date: '2026-01-05', type: 'BUY', symbol: SYMBOL, quantity: 10, price: 30, currency: 'GBP' });
    await stack.drain();
    const refresh = async () => {
      await stack.enqueue('refreshPrices', { trigger: 'scheduled' });
      await stack.drain();
      expect(await stack.failedJobs()).toEqual([]);
    };
    await refresh();
    const items = stack.core.platform.items;
    const lastValue = async (): Promise<number> => {
      const points = (await call('GET', `/history?portfolioId=${portfolio}&range=ALL`)).body.points as { value: number }[];
      return points.at(-1)!.value;
    };
    const eodRows = () => queryAll(items, { pk: keys.tickerPk(SYMBOL), sk: { beginsWith: keys.eodPrefix } });
    // Rewrites the stored rows into the old shape (pence, labelled GBX) and forgets that the repair ran.
    const makeLegacy = async () => {
      const quote = await items.get(keys.quote(SYMBOL));
      const rows = [...(await eodRows()), ...(quote === undefined ? [] : [quote])];
      await items.batchWrite(
        rows.map((item) => {
          const pence: Record<string, unknown> = { ...item, currency: 'GBX' };
          for (const field of ['close', 'price', 'previousClose']) if (typeof item[field] === 'number') pence[field] = item[field] * 100;
          return { type: 'put', item: pence as never };
        }),
      );
      await items.delete(REPAIR_MARKER);
    };
    return { stack, items, lastValue, eodRows, refresh, makeLegacy };
  }

  it('never values the pence rows a hundred times, even before the repair has run (read-time rescale)', async () => {
    const { stack, lastValue, eodRows, makeLegacy } = await started();
    const sane = await lastValue();
    expect(sane).toBeGreaterThan(340);
    expect(sane).toBeLessThan(360);

    await makeLegacy();
    expect((await eodRows()).every((row) => row.currency === 'GBX' && Number(row.close) > 1000)).toBe(true);
    expect(await lastValue()).toBeCloseTo(sane, 6);
    await stack.dispose();
  });

  it('repairs the stored rows in the refresh job, once, and a second refresh rewrites nothing', async () => {
    const { stack, items, lastValue, eodRows, refresh, makeLegacy } = await started();
    const sane = await lastValue();
    await makeLegacy();

    await refresh();
    const repaired = await eodRows();
    expect(repaired.map((row) => [row.date, row.currency])).toEqual(londonPenceCloses(T0).map(([date]) => [date, 'GBP']));
    expect(repaired.map((row) => row.close)).toEqual(LONDON_PENCE.map((close) => close / 100));
    expect(await items.get(keys.quote(SYMBOL))).toMatchObject({ currency: 'GBP' });
    const marker = await items.get(REPAIR_MARKER);
    expect(marker).toMatchObject({ written: LONDON_PENCE.length + 1 });
    expect(await lastValue()).toBeCloseTo(sane, 6);

    await refresh();
    expect(await eodRows()).toEqual(repaired);
    expect(await items.get(REPAIR_MARKER)).toEqual(marker);
    await stack.dispose();
  });
});
