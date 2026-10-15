import { describe, expect, it } from 'vitest';
import {
  BETA_BANDS,
  PE_GAUGE_SCALE,
  SHARPE_GAUGE_SCALE,
  SORTINO_GAUGE_SCALE,
  benchmarkPe,
  betaOf,
  calculatePortfolioPe,
  gaugePosition,
  isShortHistory,
  riskFigures,
  sharpeVerdict,
  sortinoVerdict,
  volatilityScale,
  volatilityVerdict,
  weightedHarmonicPe,
} from './metrics.js';
import { SHORT_HISTORY_OBSERVATIONS } from './metrics-api.js';
import { addIsoDays, riskStats, toTradingDayReturns, type DailyReturn } from './analytics.js';
import type { AssetClass, Holding, InstrumentProfile } from './types.js';

const holding = (symbol: string, assetClass: AssetClass, marketValue: number, name = `${symbol} Inc`): Holding => ({
  symbol,
  name,
  assetClass,
  sector: 'Technology',
  country: 'United States',
  currency: 'EUR',
  quantity: 1,
  averageCostLocal: marketValue,
  priceLocal: marketValue,
  averageCostBase: marketValue,
  priceBase: marketValue,
  priceStale: false,
  costBasis: marketValue,
  marketValue,
  unrealizedPnl: 0,
  unrealizedPnlPct: 0,
  currencyEffect: 0,
  dayChange: 0,
  dayChangePct: 0,
  realizedPnl: 0,
  dividendsReceived: 0,
  weight: 0,
});
const profile = (symbol: string, extra: Partial<InstrumentProfile> = {}): InstrumentProfile => ({ symbol, name: symbol, assetClass: 'STOCK', currency: 'EUR', ...extra });

describe('weightedHarmonicPe', () => {
  it('is 16 (not the arithmetic 25) for P/E 10 and 40 at equal value', () => {
    expect(weightedHarmonicPe([{ value: 1000, pe: 10 }, { value: 1000, pe: 40 }])).toBeCloseTo(16, 10);
  });

  it('weights by value: 3x as much in the P/E 10 stock', () => {
    // 4000 / (3000/10 + 1000/40) = 4000 / 325
    expect(weightedHarmonicPe([{ value: 3000, pe: 10 }, { value: 1000, pe: 40 }])).toBeCloseTo(12.3077, 4);
  });

  it('equals the P/E of a single stock and is null for nothing or zero value', () => {
    expect(weightedHarmonicPe([{ value: 50, pe: 22.5 }])).toBeCloseTo(22.5, 10);
    expect(weightedHarmonicPe([])).toBeNull();
    expect(weightedHarmonicPe([{ value: 0, pe: 10 }])).toBeNull();
  });
});

describe('calculatePortfolioPe', () => {
  const profiles = {
    AAA: profile('AAA', { peRatio: 10, fundamentalsAsOf: '2026-10-01' }),
    BBB: profile('BBB', { peRatio: 40, fundamentalsAsOf: '2026-09-01' }),
    CCC: profile('CCC'),
    DDD: profile('DDD', { peRatio: -5 }),
    EEE: profile('EEE', { peRatio: 0 }),
    NAN: profile('NAN', { peRatio: Number.NaN }),
    ETF: profile('ETF', { assetClass: 'ETF', peRatio: 18 }),
  };

  it('averages two stocks of equal value to 16 and reports full coverage of the stocks', () => {
    const r = calculatePortfolioPe([holding('AAA', 'STOCK', 1000), holding('BBB', 'STOCK', 1000)], profiles);
    expect(r.portfolio).toBe(16);
    expect(r.coverage).toEqual({
      includedStocks: 2,
      totalStocks: 2,
      nonStockHoldings: 0,
      includedValue: 2000,
      stockValue: 2000,
      portfolioValue: 2000,
      portfolioSharePct: 100,
      stockSharePct: 100,
    });
    expect(r.excluded).toEqual([]);
    expect(r.asOf).toBe('2026-09-01');
  });

  it('ignores ETFs, crypto and bonds even when they carry a P/E and reports the coverage maths', () => {
    const r = calculatePortfolioPe(
      [holding('AAA', 'STOCK', 600), holding('CCC', 'STOCK', 200), holding('ETF', 'ETF', 1000), holding('BTC-EUR', 'CRYPTO', 200)],
      profiles,
    );
    expect(r.portfolio).toBe(10);
    expect(r.coverage).toMatchObject({
      includedStocks: 1,
      totalStocks: 2,
      nonStockHoldings: 2,
      includedValue: 600,
      stockValue: 800,
      portfolioValue: 2000,
      portfolioSharePct: 30,
      stockSharePct: 75,
    });
    expect(r.excluded).toEqual([{ symbol: 'CCC', name: 'CCC Inc', reason: 'missing', marketValue: 200 }]);
  });

  it('excludes missing and non-positive P/Es with the reason, largest first', () => {
    const r = calculatePortfolioPe(
      [holding('AAA', 'STOCK', 100), holding('CCC', 'STOCK', 50), holding('DDD', 'STOCK', 300), holding('EEE', 'STOCK', 50), holding('NAN', 'STOCK', 5), holding('ZZZ', 'STOCK', 1)],
      profiles,
    );
    expect(r.excluded.map((e) => [e.symbol, e.reason])).toEqual([
      ['DDD', 'non-positive'],
      ['CCC', 'missing'],
      ['EEE', 'non-positive'],
      ['NAN', 'non-positive'],
      ['ZZZ', 'missing'],
    ]);
    expect(r.coverage.includedStocks).toBe(1);
    expect(r.asOf).toBe('2026-10-01');
  });

  it('has no P/E and zero coverage when no stock has earnings data, or when there are no stocks', () => {
    const none = calculatePortfolioPe([holding('CCC', 'STOCK', 100), holding('ETF', 'ETF', 100)], profiles);
    expect(none.portfolio).toBeNull();
    expect(none.coverage).toMatchObject({ includedStocks: 0, totalStocks: 1, portfolioSharePct: 0, stockSharePct: 0, nonStockHoldings: 1 });
    expect(none.asOf).toBeNull();
    const noStocks = calculatePortfolioPe([holding('ETF', 'ETF', 100)], profiles);
    expect(noStocks.coverage).toMatchObject({ totalStocks: 0, stockSharePct: 0, portfolioSharePct: 0 });
    const empty = calculatePortfolioPe([], {});
    expect(empty).toMatchObject({ portfolio: null, coverage: { portfolioValue: 0, portfolioSharePct: 0 } });
  });

  it('keeps a covered stock without an as-of date out of the date range', () => {
    const r = calculatePortfolioPe([holding('FFF', 'STOCK', 100)], { FFF: profile('FFF', { peRatio: 20 }) });
    expect(r).toMatchObject({ portfolio: 20, asOf: null });
  });

  it('is null when the covered stocks have no value', () => {
    expect(calculatePortfolioPe([holding('AAA', 'STOCK', 0)], profiles).portfolio).toBeNull();
  });
});

describe('benchmarkPe', () => {
  it('uses a positive P/E of the benchmark profile only', () => {
    expect(benchmarkPe(profile('B', { peRatio: 19.456 }))).toBe(19.46);
    expect(benchmarkPe(profile('B'))).toBeNull();
    expect(benchmarkPe(profile('B', { peRatio: -3 }))).toBeNull();
    expect(benchmarkPe(undefined)).toBeNull();
  });
});

describe('verdict bands', () => {
  it.each([
    [null, null],
    [0.5, 'lower'],
    [0.899, 'lower'],
    [0.9, 'in-line'],
    [1, 'in-line'],
    [1.1, 'in-line'],
    [1.101, 'higher'],
    [1.8, 'higher'],
  ])('beta %s → %s', (beta, level) => {
    expect(volatilityVerdict(beta)?.level ?? null).toBe(level);
  });

  it('words the volatility verdict', () => {
    expect(volatilityVerdict(0.679)).toEqual({ level: 'lower', label: 'lower than the market', tone: 'positive' });
    expect(volatilityVerdict(1)).toEqual({ level: 'in-line', label: 'in line with the market', tone: 'neutral' });
    expect(volatilityVerdict(1.3)).toEqual({ level: 'higher', label: 'higher than the market', tone: 'caution' });
    expect(BETA_BANDS).toEqual({ lowerBelow: 0.9, higherAbove: 1.1 });
  });

  it.each([
    [null, null],
    [-0.5, 'poor'],
    [-0.001, 'poor'],
    [0, 'attention'],
    [0.787, 'attention'],
    [0.999, 'attention'],
    [1, 'good'],
    [1.5, 'good'],
    [2, 'good'],
    [2.001, 'very-good'],
    [3.4, 'very-good'],
  ])('Sharpe %s → %s', (sharpe, level) => {
    expect(sharpeVerdict(sharpe)?.level ?? null).toBe(level);
  });

  it('words the Sharpe verdict', () => {
    expect(sharpeVerdict(0.787)).toEqual({ level: 'attention', label: 'requires attention', tone: 'caution' });
    expect(sharpeVerdict(-1)).toEqual({ level: 'poor', label: 'poor', tone: 'negative' });
    expect(sharpeVerdict(1.2)).toEqual({ level: 'good', label: 'good', tone: 'positive' });
    expect(sharpeVerdict(2.5)).toEqual({ level: 'very-good', label: 'very good', tone: 'positive' });
  });

  it.each([
    [null, null],
    [-1, 'poor'],
    [0, 'attention'],
    [0.99, 'attention'],
    [1, 'acceptable'],
    [2, 'acceptable'],
    [2.01, 'good'],
    [4, 'good'],
  ])('Sortino %s → %s', (sortino, level) => {
    expect(sortinoVerdict(sortino)?.level ?? null).toBe(level);
  });

  it('words the Sortino verdict', () => {
    expect(sortinoVerdict(-0.2)).toEqual({ level: 'poor', label: 'poor', tone: 'negative' });
    expect(sortinoVerdict(0.5)).toEqual({ level: 'attention', label: 'requires attention', tone: 'caution' });
    expect(sortinoVerdict(1.5)).toEqual({ level: 'acceptable', label: 'acceptable', tone: 'neutral' });
    expect(sortinoVerdict(3)).toEqual({ level: 'good', label: 'good', tone: 'positive' });
  });

  it('flags a short history below 60 observations', () => {
    expect(isShortHistory(SHORT_HISTORY_OBSERVATIONS - 1)).toBe(true);
    expect(isShortHistory(SHORT_HISTORY_OBSERVATIONS)).toBe(false);
  });
});

describe('gauges', () => {
  it('maps values linearly onto 0..1 and pins out-of-range values to the ends', () => {
    expect(gaugePosition(0, PE_GAUGE_SCALE)).toBe(0);
    expect(gaugePosition(35, PE_GAUGE_SCALE)).toBe(0.5);
    expect(gaugePosition(70, PE_GAUGE_SCALE)).toBe(1);
    expect(gaugePosition(120, PE_GAUGE_SCALE)).toBe(1);
    expect(gaugePosition(-4, PE_GAUGE_SCALE)).toBe(0);
    expect(gaugePosition(1, SHARPE_GAUGE_SCALE)).toBe(0.5);
    expect(gaugePosition(1.5, SORTINO_GAUGE_SCALE)).toBe(0.5);
  });

  it('widens the volatility scale in steps of 10 from a 40 % floor', () => {
    expect(volatilityScale([12, 15])).toEqual({ min: 0, max: 40 });
    expect(volatilityScale([null, null])).toEqual({ min: 0, max: 40 });
    expect(volatilityScale([40, 12])).toEqual({ min: 0, max: 40 });
    expect(volatilityScale([40.01, null])).toEqual({ min: 0, max: 50 });
    expect(volatilityScale([73, 12])).toEqual({ min: 0, max: 80 });
  });
});

/** Alternating weekday returns of +1 % / -0.5 % starting on a Monday, `n` days long. */
function alternating(n: number, up = 0.01, down = -0.005): DailyReturn[] {
  const out: DailyReturn[] = [];
  for (let k = 0; k < n; k++) out.push({ date: addIsoDays('2026-01-05', k), r: k % 2 === 0 ? up : down });
  return out;
}

describe('riskFigures and betaOf', () => {
  it('matches riskStats on the weekday returns, rounded', () => {
    const returns = alternating(7 * 12);
    const trading = toTradingDayReturns(returns).map((r) => r.r);
    const stats = riskStats(trading);
    const figures = riskFigures(returns);
    expect(figures.observations).toBe(trading.length);
    expect(figures.volatilityPct).toBeCloseTo(stats.volatility! * 100, 2);
    expect(figures.sharpe).toBeCloseTo(stats.sharpe!, 3);
    expect(figures.sortino).toBeCloseTo(stats.sortino!, 3);
  });

  it('gives null figures below 20 weekday returns but still counts them', () => {
    expect(riskFigures(alternating(14))).toEqual({ observations: 10, volatilityPct: null, sharpe: null, sortino: null });
    expect(riskFigures([])).toEqual({ observations: 0, volatilityPct: null, sharpe: null, sortino: null });
  });

  it('has no Sharpe or Sortino for a flat series (zero deviation)', () => {
    const flat = alternating(60, 0, 0);
    expect(riskFigures(flat)).toMatchObject({ volatilityPct: 0, sharpe: null });
  });

  it('computes beta 2 against a benchmark that moves half as much, and null for a flat benchmark or short history', () => {
    const bench = alternating(7 * 12, 0.005, -0.0025);
    const mine = alternating(7 * 12, 0.01, -0.005);
    expect(betaOf(mine, bench)).toBe(2);
    expect(betaOf(mine, alternating(7 * 12, 0, 0))).toBeNull();
    expect(betaOf(alternating(14), alternating(14))).toBeNull();
    expect(betaOf([], [])).toBeNull();
  });
});
