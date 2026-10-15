import { describe, expect, it } from 'vitest';
import {
  ASSET_QUOTE_STALE_DAYS,
  assetRangeStart,
  buildAssetDividends,
  computeAssetDetail,
  computeAssetHistory,
  computeAssetPositions,
  computeClosedSecurities,
  dividendStats,
  isAssetRange,
  isQuoteStale,
  seriesExtremes,
  type AssetData,
  type AssetHistoryInput,
  type AssetPositionsInput,
} from './asset-detail.js';
import {
  ASSET_RANGES,
  MAX_ASSET_POINTS,
  assetHistoryQuerySchema,
  assetSymbolSchema,
} from './asset-detail-api.js';
import { addIsoDays } from './analytics.js';
import type { DividendEvent, EodPrice, FxRates, InstrumentProfile, Quote, Transaction } from './types.js';

const TODAY = '2026-06-15';
const fx: FxRates = { base: 'EUR', rates: { USD: 1.25 }, asOf: `${TODAY}T00:00:00Z` };
const profile: InstrumentProfile = { symbol: 'AAA', name: 'Alpha Inc', assetClass: 'STOCK', sector: 'Technology', country: 'United States', exchange: 'NYSE', currency: 'USD' };
const quote: Quote = { symbol: 'AAA', price: 120, previousClose: 100, currency: 'USD', asOf: `${TODAY}T10:00:00.000Z`, source: 't' };

let seq = 0;
const tx = (p: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  userId: 'demo',
  portfolioId: 'default',
  date: '2026-01-05',
  type: 'BUY',
  symbol: 'AAA',
  quantity: 10,
  price: 100,
  fee: 0,
  currency: 'USD',
  createdAt: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
  ...p,
});
const eod = (date: string, close: number, symbol = 'AAA', currency = 'USD'): EodPrice => ({ symbol, date, close, currency });
const div = (exDate: string, amount: number, extra: Partial<DividendEvent> = {}): DividendEvent => ({ symbol: 'AAA', exDate, amount, currency: 'USD', ...extra });

/** One close per day from `start` for `n` days, rising by 1 a day from 100. */
const daily = (start: string, n: number, symbol = 'AAA'): EodPrice[] => Array.from({ length: n }, (_, i) => eod(addIsoDays(start, i), 100 + i, symbol));

describe('ranges', () => {
  it('maps every range to its start date', () => {
    expect(assetRangeStart('7D', TODAY)).toBe('2026-06-08');
    expect(assetRangeStart('1M', TODAY)).toBe('2026-05-16');
    expect(assetRangeStart('3M', TODAY)).toBe('2026-03-16');
    expect(assetRangeStart('6M', TODAY)).toBe('2025-12-15');
    expect(assetRangeStart('YTD', TODAY)).toBe('2026-01-01');
    expect(assetRangeStart('1Y', TODAY)).toBe('2025-06-15');
    expect(assetRangeStart('5Y', TODAY)).toBe('2021-06-15');
    expect(assetRangeStart('ALL', TODAY, '2024-02-01')).toBe('2024-02-01');
    expect(assetRangeStart('ALL', TODAY)).toBe('2025-06-15');
  });

  it('recognises valid ranges only', () => {
    for (const r of ASSET_RANGES) expect(isAssetRange(r)).toBe(true);
    expect(isAssetRange('2Y')).toBe(false);
    expect(isAssetRange(undefined)).toBe(false);
  });
});

describe('query schemas', () => {
  it('accepts canonical symbols and rejects reserved ones', () => {
    expect(assetSymbolSchema.parse('btc-eur')).toBe('BTC-EUR');
    expect(assetSymbolSchema.parse('ASML.AS')).toBe('ASML.AS');
    expect(assetSymbolSchema.safeParse('CASH.EUR').success).toBe(false);
    expect(assetSymbolSchema.safeParse('CUSTOM:abc').success).toBe(false);
    expect(assetSymbolSchema.safeParse('bad symbol').success).toBe(false);
  });

  it('defaults the range and benchmark like the Growth view', () => {
    expect(assetHistoryQuerySchema.parse({})).toEqual({ range: '1Y', benchmarks: ['IWDA.AS'] });
    expect(assetHistoryQuerySchema.parse({ range: '5Y', benchmarks: '', portfolioId: 'all' })).toEqual({ range: '5Y', benchmarks: [], portfolioId: 'all' });
    expect(assetHistoryQuerySchema.parse({ benchmarks: 'iwda.as,vwrl.as' }).benchmarks).toEqual(['IWDA.AS', 'VWRL.AS']);
    expect(assetHistoryQuerySchema.safeParse({ benchmarks: 'no good' }).success).toBe(false);
    expect(assetHistoryQuerySchema.safeParse({ benchmarks: 'A,B,C,D' }).success).toBe(false);
    expect(assetHistoryQuerySchema.safeParse({ range: '2Y' }).success).toBe(false);
  });
});

describe('seriesExtremes', () => {
  it('finds the first minimum and maximum, skipping nulls', () => {
    const values = [3, null, 1, 5, 1, 5];
    expect(seriesExtremes(values, (v) => v)).toEqual({ min: { index: 2, value: 1 }, max: { index: 3, value: 5 } });
  });

  it('is empty without values', () => {
    expect(seriesExtremes([] as number[], (v) => v)).toEqual({ min: null, max: null });
    expect(seriesExtremes([null], (v) => v)).toEqual({ min: null, max: null });
  });
});

describe('dividends', () => {
  it('lists events newest first and totals per year', () => {
    const d = buildAssetDividends([div('2025-03-01', 0.25), div('2026-03-01', 0.3, { payDate: '2026-03-20' }), div('2025-09-01', 0.25)], TODAY);
    expect(d.currency).toBe('USD');
    expect(d.events.map((e) => e.exDate)).toEqual(['2026-03-01', '2025-09-01', '2025-03-01']);
    expect(d.events[0]).toEqual({ exDate: '2026-03-01', payDate: '2026-03-20', amount: 0.3 });
    expect(d.events[1]!.payDate).toBeNull();
    expect(d.byYear).toEqual([
      { year: 2025, perShare: 0.5, payments: 2, complete: false },
      { year: 2026, perShare: 0.3, payments: 1, complete: false },
    ]);
  });

  it('is empty without events', () => {
    expect(buildAssetDividends([], TODAY)).toEqual({ currency: null, events: [], byYear: [] });
  });

  it('marks a first year complete when it holds as many payments as the next one', () => {
    const events = [div('2023-04-01', 1), div('2023-10-01', 1), div('2024-04-01', 1.2), div('2024-10-01', 1.2), div('2025-04-01', 1.4), div('2025-10-01', 1.4)];
    const d = buildAssetDividends(events, TODAY);
    expect(d.byYear.map((y) => y.complete)).toEqual([true, true, true]);
  });

  it('never marks a lone past year complete (coverage unknown)', () => {
    expect(buildAssetDividends([div('2024-04-01', 1)], TODAY).byYear[0]!.complete).toBe(false);
  });
});

describe('dividendStats', () => {
  const base = (events: DividendEvent[], over: Partial<Parameters<typeof dividendStats>[0]> = {}) => {
    const dividends = buildAssetDividends(events, TODAY);
    return dividendStats({ events, dividends, today: TODAY, price: { value: 100, currency: 'USD' }, eps: 5, profileCurrency: 'USD', ...over });
  };

  it('computes trailing yield, payout, next ex-date and growth', () => {
    const events = [
      div('2023-04-01', 1), div('2023-10-01', 1),
      div('2024-04-01', 1.1), div('2024-10-01', 1.1),
      div('2025-04-01', 1.21), div('2025-10-01', 1.21),
      div('2026-04-01', 1.331),
      div('2026-07-01', 1.331),
    ];
    const s = base(events);
    expect(s.annualDividend).toBe(2.541);
    expect(s.dividendYieldPct).toBe(2.54);
    expect(s.payoutRatioPct).toBe(50.8);
    expect(s.nextExDate).toBe('2026-07-01');
    expect(s.nextDividendAmount).toBe(1.331);
    expect(s.dividendGrowth).toEqual({ years: 2, cagrPct: 10 });
    expect(s.dividendIncreaseStreak).toBe(2);
  });

  it('reports nothing without events', () => {
    expect(base([])).toEqual({
      dividendYieldPct: null,
      annualDividend: null,
      nextExDate: null,
      nextDividendAmount: null,
      payoutRatioPct: null,
      dividendGrowth: null,
      dividendIncreaseStreak: null,
    });
  });

  it('needs a price in the dividend currency for the yield and a positive EPS in it for the payout', () => {
    const events = [div('2026-03-01', 1)];
    expect(base(events, { price: null }).dividendYieldPct).toBeNull();
    expect(base(events, { price: { value: 100, currency: 'EUR' } }).dividendYieldPct).toBeNull();
    expect(base(events, { price: { value: 0, currency: 'USD' } }).dividendYieldPct).toBeNull();
    expect(base(events, { eps: null }).payoutRatioPct).toBeNull();
    expect(base(events, { eps: -2 }).payoutRatioPct).toBeNull();
    expect(base(events, { profileCurrency: 'EUR' }).payoutRatioPct).toBeNull();
    expect(base(events).payoutRatioPct).toBe(20);
  });

  it('ignores events older than a year for the trailing figures', () => {
    expect(base([div('2025-06-15', 1)]).annualDividend).toBeNull();
    expect(base([div('2025-06-16', 1)]).annualDividend).toBe(1);
  });

  it('breaks the growth run at a gap and reports a zero streak after a cut', () => {
    const gap = [div('2020-04-01', 1), div('2020-10-01', 1), div('2021-04-01', 1), div('2021-10-01', 1), div('2023-04-01', 2), div('2023-10-01', 2), div('2024-04-01', 2), div('2024-10-01', 2)];
    expect(base(gap).dividendGrowth).toEqual({ years: 1, cagrPct: 0 });
    expect(base(gap).dividendIncreaseStreak).toBe(0);
    const cut = [div('2023-04-01', 2), div('2023-10-01', 2), div('2024-04-01', 3), div('2024-10-01', 3), div('2025-04-01', 1), div('2025-10-01', 1)];
    expect(base(cut).dividendIncreaseStreak).toBe(0);
    expect(base(cut).dividendGrowth!.cagrPct).toBeLessThan(0);
  });

  it('has no growth for a zero first year or a single complete year', () => {
    const zero = [div('2023-04-01', 0), div('2024-04-01', 1), div('2025-04-01', 1)];
    expect(base(zero).dividendGrowth).toBeNull();
    expect(base([div('2025-04-01', 1), div('2025-10-01', 1)]).dividendGrowth).toBeNull();
  });

  it('limits the run to the last five year-over-year steps', () => {
    const events = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025].flatMap((y, i) => [div(`${y}-04-01`, 1 + i), div(`${y}-10-01`, 1 + i)]);
    expect(base(events).dividendGrowth!.years).toBe(5);
    expect(base(events).dividendIncreaseStreak).toBe(5);
  });
});

describe('computeAssetDetail', () => {
  const data = (over: Partial<AssetData> = {}): AssetData => ({ symbol: 'AAA', today: TODAY, profile, quote, eod: [], dividendEvents: [], fx, ...over });

  it('is null when nothing is stored', () => {
    expect(computeAssetDetail(data({ profile: undefined, quote: undefined }))).toBeNull();
  });

  it('describes profile, quote and stats', () => {
    const detail = computeAssetDetail(
      data({
        profile: { ...profile, description: ' About ', isin: 'US0000000001', peRatio: 20, eps: 6, beta: 1.1, marketCap: 3e12 },
        dividendEvents: [div('2026-03-01', 1.2)],
      }),
    )!;
    expect(detail.baseCurrency).toBe('EUR');
    expect(detail.profile).toMatchObject({ symbol: 'AAA', name: 'Alpha Inc', sector: 'Technology', country: 'United States', exchange: 'NYSE', description: ' About ', isin: 'US0000000001' });
    expect(detail.quote).toEqual({ source: 'quote', price: 120, previousClose: 100, change: 20, changePct: 20, currency: 'USD', asOf: quote.asOf, priceBase: 96 });
    expect(detail.stats).toMatchObject({ peRatio: 20, eps: 6, beta: 1.1, marketCap: 3e12, dividendYieldPct: 1, annualDividend: 1.2, payoutRatioPct: 20, nextEarningsDate: null });
  });

  it('leaves unknown fields null instead of inventing them', () => {
    const detail = computeAssetDetail(data({ profile: { symbol: 'AAA', name: 'Alpha', assetClass: 'ETF', currency: 'USD', description: '  ' } }))!;
    expect(detail.profile).toMatchObject({ sector: null, country: null, exchange: null, description: null, isin: null });
    expect(detail.stats).toMatchObject({ peRatio: null, eps: null, beta: null, marketCap: null, dividendYieldPct: null, nextExDate: null });
  });

  it('falls back to the stored closes when there is no quote', () => {
    const detail = computeAssetDetail(data({ quote: undefined, eod: [eod('2026-06-12', 110), eod('2026-06-11', 100)] }))!;
    expect(detail.quote).toMatchObject({ source: 'eod', price: 110, previousClose: 100, change: 10, changePct: 10, asOf: '2026-06-12' });
  });

  it('uses the only close as its own previous close and handles a zero previous close', () => {
    const one = computeAssetDetail(data({ quote: undefined, eod: [eod('2026-06-12', 110)] }))!;
    expect(one.quote).toMatchObject({ change: 0, changePct: 0 });
    const zero = computeAssetDetail(data({ quote: { ...quote, previousClose: 0 } }))!;
    expect(zero.quote!.changePct).toBe(0);
  });

  it('has no quote without a quote or closes, and no base price without an FX rate', () => {
    expect(computeAssetDetail(data({ quote: undefined }))!.quote).toBeNull();
    const noRate = computeAssetDetail(data({ fx: { base: 'EUR', rates: {}, asOf: TODAY } }))!;
    expect(noRate.quote!.priceBase).toBeNull();
  });

  it('rethrows unexpected errors from the FX conversion', () => {
    const broken = { base: 'EUR', get rates(): Record<string, number> { throw new Error('boom'); }, asOf: TODAY } as FxRates;
    expect(() => computeAssetDetail(data({ fx: broken }))).toThrow('boom');
  });

  it('takes the currency from the quote or the closes when the profile is missing', () => {
    expect(computeAssetDetail(data({ profile: undefined }))!.profile.currency).toBe('USD');
    expect(computeAssetDetail(data({ profile: undefined, quote: undefined, eod: [eod('2026-06-12', 1, 'AAA', 'CHF')] }))!.profile.currency).toBe('CHF');
    const bare = computeAssetDetail(data({ profile: undefined, quote: undefined, eod: [eod('2026-06-12', 1)] }))!;
    expect(bare.profile).toMatchObject({ name: 'AAA', assetClass: 'OTHER' });
  });

  it('ignores non-finite profile numbers', () => {
    const detail = computeAssetDetail(data({ profile: { ...profile, peRatio: Number.NaN, beta: Number.POSITIVE_INFINITY } }))!;
    expect(detail.stats.peRatio).toBeNull();
    expect(detail.stats.beta).toBeNull();
  });
});

describe('computeAssetHistory', () => {
  const input = (over: Partial<AssetHistoryInput> = {}): AssetHistoryInput => ({
    symbol: 'AAA',
    today: TODAY,
    range: '1M',
    eod: daily('2026-04-01', 76),
    transactions: [],
    fx,
    profile,
    ...over,
  });

  it('returns the range as percent change since its first close', () => {
    const h = computeAssetHistory(input());
    expect(h.currency).toBe('USD');
    expect(h.points[0]).toEqual({ date: '2026-05-16', close: 145, pct: 0 });
    expect(h.points.at(-1)).toEqual({ date: TODAY, close: 175, pct: 20.69 });
    expect(h.benchmarks).toEqual([]);
    expect(h.options).toEqual([]);
    expect(h.coverage).toEqual({ from: '2026-04-01', to: TODAY, limited: false });
  });

  it('flags a range that starts before the stored history, but never for ALL', () => {
    expect(computeAssetHistory(input({ range: '1Y' })).coverage.limited).toBe(true);
    const all = computeAssetHistory(input({ range: 'ALL' }));
    expect(all.coverage.limited).toBe(false);
    expect(all.points[0]!.date).toBe('2026-04-01');
  });

  it('drops closes after today and is empty without prices', () => {
    expect(computeAssetHistory(input({ eod: [eod('2026-06-20', 1)] })).points).toEqual([]);
    const none = computeAssetHistory(input({ eod: [], profile: undefined, quote }));
    expect(none).toMatchObject({ points: [], currency: 'USD', coverage: { from: null, to: null, limited: false } });
    expect(computeAssetHistory(input({ eod: [], profile: undefined })).currency).toBe('EUR');
    expect(computeAssetHistory(input({ eod: [eod('2026-06-01', 5, 'AAA', 'CHF')], profile: undefined })).currency).toBe('CHF');
  });

  it('samples long series down while keeping both ends', () => {
    const h = computeAssetHistory(input({ range: 'ALL', eod: daily('2024-01-01', 900) }));
    expect(h.points).toHaveLength(MAX_ASSET_POINTS);
    expect(h.points[0]!.date).toBe('2024-01-01');
  });

  it('carries benchmarks forward, rebases them at the series start and echoes the options', () => {
    const benchmarks = [
      { symbol: 'IWDA.AS', eod: [eod('2026-06-10', 50, 'IWDA.AS', 'EUR'), eod('2026-06-12', 55, 'IWDA.AS', 'EUR')] },
      { symbol: 'XXX', eod: [] },
    ];
    const options = [{ symbol: 'IWDA.AS', hasData: true }];
    const h = computeAssetHistory(input({ range: '7D', benchmarks, options }));
    expect(h.options).toEqual(options);
    const [iwda, none] = h.benchmarks;
    expect(iwda).toMatchObject({ symbol: 'IWDA.AS', available: true, comparison: null });
    expect(iwda!.points).toHaveLength(h.points.length);
    const at = (date: string) => iwda!.points[h.points.findIndex((p) => p.date === date)];
    expect(at('2026-06-09')).toEqual({ value: null, returnPct: null });
    expect(at('2026-06-10')).toEqual({ value: 50, returnPct: 0 });
    expect(at('2026-06-11')).toEqual({ value: 50, returnPct: 0 });
    expect(at('2026-06-12')).toEqual({ value: 55, returnPct: 10 });
    expect(none).toMatchObject({ symbol: 'XXX', available: false });
    expect(none!.message).toContain('XXX');
    expect(none!.points.every((p) => p.value === null && p.returnPct === null)).toBe(true);
  });

  it('marks buys, sells and dividends in the range, snapped to the series', () => {
    const h = computeAssetHistory(
      input({
        eod: daily('2026-04-01', 76).filter((p) => p.date !== '2026-06-01'),
        transactions: [
          tx({ date: '2026-05-20', type: 'BUY', quantity: 2, price: 100, fee: 5, fxRate: 1.25 }),
          tx({ date: '2026-06-01', type: 'SELL', quantity: 1, price: 150, fee: 2, portfolioId: 'p2' }),
          tx({ date: '2026-06-10', type: 'DIVIDEND', quantity: 1, price: 1, fee: 0.2 }),
          tx({ date: '2026-06-12', type: 'SPLIT', quantity: 2, price: 0, fee: 0 }),
          tx({ date: '2026-04-10', type: 'BUY' }),
          tx({ date: '2026-06-14', type: 'BUY', symbol: 'ZZZ' }),
          tx({ date: '2026-06-20', type: 'BUY' }),
        ],
      }),
    );
    expect(h.markers.map((m) => [m.date, m.plotDate, m.type, m.portfolioId, m.amountBase])).toEqual([
      ['2026-05-20', '2026-05-20', 'BUY', 'default', 164],
      ['2026-06-01', '2026-06-02', 'SELL', 'p2', 118.4],
      ['2026-06-10', '2026-06-10', 'DIVIDEND', 'default', 0.64],
    ]);
    expect(h.markers[0]).toMatchObject({ quantity: 2, price: 100 });
  });

  it('snaps a marker after the last point to the last point, and drops markers without a series', () => {
    const late = computeAssetHistory(input({ eod: daily('2026-04-01', 60), transactions: [tx({ date: '2026-06-14' })] }));
    expect(late.markers[0]!.plotDate).toBe('2026-05-30');
    const none = computeAssetHistory(input({ eod: [], transactions: [tx({ date: '2026-06-14' })] }));
    expect(none.markers).toEqual([]);
  });
});

describe('computeAssetPositions', () => {
  const input = (over: Partial<AssetPositionsInput> = {}): AssetPositionsInput => ({
    symbol: 'AAA',
    today: TODAY,
    transactions: [],
    profile,
    quote,
    fx,
    portfolios: [{ portfolioId: 'default', name: 'Main portfolio' }, { portfolioId: 'p2', name: 'Broker' }],
    portfolioValues: { default: 1000, p2: 500 },
    ...over,
  });

  it('is empty when the user never traded the symbol', () => {
    const r = computeAssetPositions(input({ transactions: [tx({ symbol: 'OTHER' })] }));
    expect(r).toMatchObject({ symbol: 'AAA', baseCurrency: 'EUR', currency: 'USD', positions: [], totals: null, received: [] });
    expect(computeAssetPositions(input({ profile: undefined })).currency).toBeNull();
  });

  it('describes an open position per portfolio with profit, capital gain and weight', () => {
    const r = computeAssetPositions(
      input({
        transactions: [
          tx({ date: '2026-01-05', quantity: 10, price: 100, fxRate: 1.25 }),
          tx({ date: '2026-03-01', type: 'DIVIDEND', quantity: 10, price: 1, fee: 0.5, fxRate: 1.25 }),
          tx({ date: '2026-02-01', type: 'BUY', quantity: 5, price: 100, portfolioId: 'p2', fxRate: 1.25 }),
          tx({ date: '2026-03-01', type: 'SELL', quantity: 2, price: 110, portfolioId: 'p2', fxRate: 1.25 }),
        ],
      }),
    );
    const main = r.positions.find((p) => p.portfolioId === 'default')!;
    expect(main).toMatchObject({ portfolioName: 'Main portfolio', status: 'open', quantity: 10, averageCostBase: 80, averageCostLocal: 100, costBasis: 800, marketValue: 960, unrealizedPnl: 160, unrealizedPnlPct: 20, realizedPnl: 0, capitalGain: 160, dividendsReceived: 7.6, weight: 0.96, firstTradeDate: '2026-01-05', lastTradeDate: '2026-01-05' });
    expect(main.profit).toBeCloseTo(167.6, 2);
    expect(main.profitPct).toBeCloseTo(20.95, 1);
    const second = r.positions.find((p) => p.portfolioId === 'p2')!;
    expect(second).toMatchObject({ status: 'open', quantity: 3, lastTradeDate: '2026-03-01', firstTradeDate: '2026-02-01' });
    expect(second.realizedPnl).toBeCloseTo(16, 2);
    expect(second.capitalGain).toBeCloseTo(second.unrealizedPnl + second.realizedPnl, 2);
    expect(r.positions.map((p) => p.portfolioId)).toEqual(['default', 'p2']);
    expect(r.totals).toMatchObject({ quantity: 13 });
    expect(r.totals!.profit).toBeCloseTo(main.profit + second.profit, 1);
    expect(r.received).toEqual([{ date: '2026-03-01', portfolioId: 'default', quantity: 10, perShareLocal: 1, currency: 'USD', amount: 7.6 }]);
  });

  it('shows a closed position with its realised result and puts open positions first', () => {
    const r = computeAssetPositions(
      input({
        transactions: [
          tx({ date: '2026-01-05', quantity: 10, price: 100, portfolioId: 'default', fxRate: 1.25 }),
          tx({ date: '2026-02-05', type: 'SELL', quantity: 10, price: 130, portfolioId: 'default', fxRate: 1.25 }),
          tx({ date: '2026-02-06', type: 'BUY', quantity: 1, price: 100, portfolioId: 'p2', fxRate: 1.25 }),
        ],
      }),
    );
    expect(r.positions.map((p) => [p.portfolioId, p.status])).toEqual([['p2', 'open'], ['default', 'closed']]);
    const closed = r.positions[1]!;
    expect(closed).toMatchObject({ quantity: 0, averageCostBase: 0, marketValue: 0, weight: null, realizedPnl: 240, capitalGain: 240, profit: 240, lastTradeDate: '2026-02-05' });
    expect(closed.profitPct).toBe(30);
    expect(r.totals).not.toBeNull();
  });

  it('orders equally ranked positions by portfolio name and copes with unknown portfolios, weights and quotes', () => {
    const r = computeAssetPositions(
      input({
        quote: undefined,
        profile: undefined,
        portfolios: [{ portfolioId: 'b', name: 'Beta' }],
        portfolioValues: { b: 0 },
        transactions: [
          tx({ portfolioId: 'b', currency: 'EUR' }),
          tx({ portfolioId: 'a', currency: 'EUR' }),
        ],
      }),
    );
    expect(r.positions.map((p) => p.portfolioName)).toEqual(['a', 'Beta']);
    expect(r.positions.every((p) => p.weight === null)).toBe(true);
    expect(r.positions[0]).toMatchObject({ quantity: 10, marketValue: 1000, unrealizedPnl: 0 });
  });

  it('leaves the weight empty without a portfolio value', () => {
    const r = computeAssetPositions(input({ portfolioValues: {}, transactions: [tx({})] }));
    expect(r.positions[0]!.weight).toBeNull();
  });
});

describe('computeClosedSecurities', () => {
  const profiles = { AAA: profile };
  it('lists fully sold market symbols with their realised result', () => {
    const r = computeClosedSecurities({
      transactions: [
        tx({ date: '2026-01-05', quantity: 10, price: 100, fxRate: 1.25 }),
        tx({ date: '2026-02-05', type: 'SELL', quantity: 4, price: 120, fxRate: 1.25 }),
        tx({ date: '2026-03-05', type: 'SELL', quantity: 6, price: 110, fxRate: 1.25 }),
        tx({ date: '2026-03-06', type: 'DIVIDEND', quantity: 6, price: 1, fxRate: 1.25 }),
        tx({ symbol: 'HELD', quantity: 1 }),
        tx({ symbol: 'ZED', date: '2026-01-05', quantity: 1, price: 0, currency: 'EUR' }),
        tx({ symbol: 'ZED', date: '2026-01-06', type: 'SELL', quantity: 1, price: 0, currency: 'EUR' }),
        tx({ type: 'DEPOSIT', symbol: 'CASH.EUR', currency: 'EUR', quantity: 100, price: 1 }),
      ],
      profiles,
      fx,
    });
    expect(r.baseCurrency).toBe('EUR');
    expect(r.securities.map((s) => s.symbol)).toEqual(['AAA', 'ZED']);
    expect(r.securities[0]).toMatchObject({ name: 'Alpha Inc', sector: 'Technology', country: 'United States', currency: 'USD', lastSoldDate: '2026-03-05' });
    expect(r.securities[0]!.realizedPnl).toBeCloseTo(((4 * 120 + 6 * 110) - 1000) / 1.25, 2);
    expect(r.securities[0]!.dividendsReceived).toBe(4.8);
    expect(r.securities[0]!.profit).toBeCloseTo(r.securities[0]!.realizedPnl + 4.8, 2);
    expect(r.securities[0]!.profitPct).toBeCloseTo((r.securities[0]!.profit / 800) * 100, 1);
    expect(r.securities[1]).toMatchObject({ name: 'ZED', assetClass: 'OTHER', sector: 'Unknown', country: 'Unknown', profitPct: 0 });
  });

  it('is empty without trades', () => {
    expect(computeClosedSecurities({ transactions: [], profiles, fx }).securities).toEqual([]);
  });
});

describe('quote staleness', () => {
  it('is stale after the allowed number of days', () => {
    expect(ASSET_QUOTE_STALE_DAYS).toBe(4);
    expect(isQuoteStale('2026-06-11T10:00:00.000Z', TODAY)).toBe(false);
    expect(isQuoteStale('2026-06-10T10:00:00.000Z', TODAY)).toBe(true);
    expect(isQuoteStale('2026-06-15', TODAY)).toBe(false);
  });
});
