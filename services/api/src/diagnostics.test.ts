import { describe, expect, it } from 'vitest';
import type { GetValuationReportResponse } from '@portfolio/shared';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';
import { createHandler } from './lambda/handler.js';
import { TODAY, ownerScenario } from './testing/owner-scenario.js';

const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const report = async (handler: ReturnType<typeof ownerScenario>['handler'], query: Record<string, string> = {}): Promise<GetValuationReportResponse> => json(await handler(apiEvent('GET', '/diagnostics/valuation', { query })));

describe('GET /diagnostics/valuation (chart reconciliation)', () => {
  it('defaults to today, yesterday and about six months back, oldest first, and reads like the chart', async () => {
    const { handler } = ownerScenario();
    const body = await report(handler);
    expect(body.days.map((d) => d.date)).toEqual(['2025-12-15', '2026-06-14', TODAY]);
    const history = json(await handler(apiEvent('GET', '/history', { query: { range: '1Y' } })));
    for (const day of body.days) {
      expect(day.chartValue).toBeCloseTo(history.points.find((p: { date: string }) => p.date === day.date).value, 2);
      expect(day.lines.reduce((sum, line) => sum + line.value, 0)).toBeCloseTo(day.positionsValue, 1);
      expect(day.chartValue).toBeCloseTo(day.positionsValue + day.extraValue, 1);
    }
    const last = body.days.at(-1)!;
    expect(body.headline).not.toBeNull();
    expect(last.chartValue).toBeCloseTo(body.headline!, 1);
    expect(body.symbolsTotal).toBe(12);
    expect(body.truncated).toBe(false);
    expect(body.rowsRead).toBeGreaterThan(1000);
  });

  it('puts the biggest distortion first: a close of another unit rescaled, and the position valued at cost', async () => {
    const { handler } = ownerScenario();
    const day = (await report(handler, { dates: '2026-03-02' })).days[0]!;
    const gaps = day.lines.map((line) => Math.abs(line.gap));
    expect(gaps).toEqual([...gaps].sort((a, b) => b - a));
    const iitu = day.lines.find((line) => line.symbol === 'IITU.L')!;
    expect(iitu).toMatchObject({ source: 'close', priceCurrency: 'USD', currency: 'USD', flags: ['scale'] });
    // the close was stored a hundred times too small: the chart counts the rescaled one, the fair value is the stored close
    expect(iitu.value).toBeGreaterThan(50 * iitu.fair);
    expect(Math.abs(iitu.gap)).toBeGreaterThan(Math.abs(day.lines.find((line) => line.symbol === 'VWRL.AS')!.gap));
    const fwra = day.lines.find((line) => line.symbol === 'FWRA.MI')!;
    expect(fwra).toMatchObject({ source: 'cost', priceDate: null, ageDays: null, flags: ['cost'] });
    expect(fwra.value).toBeLessThan(fwra.fair);
    const aapl = day.lines.find((line) => line.symbol === 'AAPL')!;
    expect(aapl).toMatchObject({ source: 'close', ageDays: 0, flags: [], gap: 0, priceCurrency: 'USD' });
    expect(aapl.today).toBeGreaterThan(aapl.value);
  });

  it('on the last day values at the live quote with the latest rate and says so', async () => {
    const { handler } = ownerScenario();
    const last = (await report(handler, { dates: TODAY })).days[0]!;
    const aapl = last.lines.find((line) => line.symbol === 'AAPL')!;
    expect(aapl).toMatchObject({ source: 'quote', fxFallback: 'none', fxDate: null, flags: [] });
    expect(last.lines.every((line) => line.today === line.value)).toBe(true);
  });

  it('reports the FX history: its reach and the days that use another day’s rate', async () => {
    const { handler } = ownerScenario();
    const body = await report(handler);
    const usd = body.fx.find((row) => row.currency === 'USD')!;
    expect(usd).toMatchObject({ first: '2026-02-02', last: TODAY });
    expect(usd.fixings).toBeGreaterThan(100);
    // from the first purchase (15 Jan 2025) to the first stored fixing every day uses the earliest fixing
    expect(usd.fallbackDays).toBe(383);
    const old = body.days[0]!.lines.find((line) => line.symbol === 'AAPL')!;
    expect(old).toMatchObject({ fxFallback: 'before', fxDate: '2026-02-02', flags: ['fx'] });
  });

  it('says when there is no FX history at all: the latest rate stands in for every day', async () => {
    const { handler, repo } = ownerScenario();
    repo.fxDays = [];
    const body = await report(handler, { dates: '2026-03-02' });
    expect(body.fx.find((row) => row.currency === 'USD')).toMatchObject({ fixings: 0, first: null, last: null, fallbackDays: 517 });
    expect(body.days[0]!.lines.find((line) => line.symbol === 'AAPL')).toMatchObject({ fxFallback: 'latest', fxDate: null });
  });

  it('flags a close of an older day and one in another currency than the position', async () => {
    const { handler, repo } = ownerScenario();
    repo.eod = repo.eod.filter((row) => !(row.symbol === 'ADB.DE' && row.date > '2026-02-20')).map((row) => (row.symbol === 'ASML.AS' ? { ...row, currency: 'USD' } : row));
    const body = await report(handler, { dates: '2026-03-02' });
    const adb = body.days[0]!.lines.find((line) => line.symbol === 'ADB.DE')!;
    expect(adb).toMatchObject({ source: 'carried', priceDate: '2026-02-20', ageDays: 10, flags: ['carried', 'stale'] });
    expect(body.days[0]!.lines.find((line) => line.symbol === 'ASML.AS')!.flags).toContain('currency');
  });

  it('answers for a user without transactions and validates the dates', async () => {
    const { handler } = ownerScenario();
    const none = json(await handler(apiEvent('GET', '/diagnostics/valuation', { sub: 'nobody' })));
    expect(none).toMatchObject({ days: [], fx: [], headline: 0, symbolsTotal: 0, truncated: false });
    expect((await handler(apiEvent('GET', '/diagnostics/valuation', { query: { dates: 'yesterday' } }))).statusCode).toBe(400);
    expect((await handler(apiEvent('GET', '/diagnostics/valuation', { query: { dates: '2026-01-01,2026-01-02,2026-01-03,2026-01-04' } }))).statusCode).toBe(400);
    expect((await report(handler, { dates: '2099-01-01' })).days).toEqual([]);
  });

  it('examines at most 60 symbols and says it left some out', async () => {
    const ctx = fakeDeps();
    ctx.repo.portfolios = [portfolio({ portfolioId: 'default', name: 'Main' })];
    ctx.repo.transactions = Array.from({ length: 65 }, (_, i) => txn({ id: `t${i}`, date: '2026-05-01', type: 'BUY', symbol: `S${String(i).padStart(2, '0')}`, quantity: 1, price: 10 }));
    ctx.repo.fx = { base: 'EUR', rates: {}, asOf: `${TODAY}T00:00:00Z` };
    const body = json(await createHandler(() => ctx.deps)(apiEvent('GET', '/diagnostics/valuation', { query: { dates: '2026-06-01' } })));
    expect(body).toMatchObject({ symbolsTotal: 65, truncated: true });
    expect(body.days[0].lines).toHaveLength(60);
  });
});
