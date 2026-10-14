import { describe, expect, it } from 'vitest';
import { INSIGHT_THRESHOLDS, generateInsights } from './analytics-insights.js';
import type { PassiveIncome } from './analytics-income.js';
import type { Holding } from './types.js';

let n = 0;
/** Holdings with market values summing to 10 000, so a weight of 0.25 means value 2 500. */
const h = (p: Partial<Holding> & { weight: number }): Holding => {
  n += 1;
  return {
    symbol: `S${n}`,
    name: `Name ${n}`,
    assetClass: 'STOCK',
    sector: 'Diversified',
    country: 'Global',
    currency: 'EUR',
    unrealizedPnlPct: 0,
    ...p,
    marketValue: p.weight * 10_000,
  } as Holding;
};
const filler = (weight: number, extra: Partial<Holding> = {}) => h({ weight, ...extra });
const noIncome: PassiveIncome = { baseCurrency: 'EUR', forward12m: 0, declared: 0, estimated: 0, yieldOnValuePct: 0, yieldOnCostPct: 0, holdings: [] };
const ids = (holdings: Holding[], income: PassiveIncome = noIncome) => generateInsights(holdings, income).map((i) => i.id);

describe('thresholds', () => {
  it('documents the limits', () => {
    expect(INSIGHT_THRESHOLDS).toMatchObject({ topHoldingWeight: 0.25, sectorWeight: 0.4, countryWeight: 0.5, fxExposure: 0.5, incomeShare: 0.4 });
  });
});

describe('generateInsights', () => {
  it('is quiet for an empty or balanced portfolio', () => {
    expect(generateInsights([], noIncome)).toEqual([]);
    expect(ids([filler(0.2), filler(0.2), filler(0.2), filler(0.2), filler(0.2)])).toEqual([]);
  });

  it('flags a top holding strictly above 25 %', () => {
    expect(ids([filler(0.25), filler(0.75 / 3), filler(0.75 / 3), filler(0.75 / 3)])).toEqual([]);
    const insights = generateInsights([h({ weight: 0.2501, symbol: 'BIG', name: 'Big Corp' }), filler(0.25), filler(0.25), filler(0.2499)], noIncome);
    expect(insights.find((i) => i.id === 'concentration-top-holding')).toEqual({
      id: 'concentration-top-holding',
      severity: 'warning',
      title: 'BIG dominates your portfolio',
      detail: expect.stringContaining('Big Corp is 25% of your portfolio value'),
      symbols: ['BIG'],
    });
  });

  it('flags a sector strictly above 40 % but ignores diversified funds', () => {
    const tech = (weight: number, symbol: string) => h({ weight, sector: 'Technology', symbol });
    expect(ids([tech(0.2, 'A'), tech(0.2, 'B'), filler(0.2), filler(0.2), filler(0.2)])).toEqual([]);
    const hit = generateInsights([tech(0.2, 'B'), tech(0.21, 'A'), filler(0.19), filler(0.2), filler(0.2)], noIncome);
    expect(hit).toEqual([
      expect.objectContaining({ id: 'sector-imbalance', severity: 'warning', title: 'Heavy in Technology', symbols: ['A', 'B'] }),
    ]);
    expect(ids([filler(0.2), filler(0.2), filler(0.2), filler(0.2), filler(0.2)])).not.toContain('sector-imbalance');
  });

  it('flags a country strictly above 50 % but ignores global funds', () => {
    const nl = (weight: number) => h({ weight, country: 'Netherlands' });
    expect(ids([nl(0.17), nl(0.17), nl(0.16), filler(0.25), filler(0.25)])).toEqual([]);
    const hit = generateInsights([nl(0.17), nl(0.17), nl(0.17), filler(0.25), filler(0.24)], noIncome);
    expect(hit).toEqual([expect.objectContaining({ id: 'country-concentration', severity: 'info', title: 'Concentrated in Netherlands' })]);
    expect(ids([h({ weight: 0.9, country: 'Unknown' }), filler(0.1)])).toContain('concentration-top-holding');
    expect(ids([h({ weight: 0.9, country: 'Unknown' }), filler(0.1)])).not.toContain('country-concentration');
  });

  it('flags high foreign-currency exposure above 50 % and a single large currency above 40 %', () => {
    const usd = (weight: number, symbol = `U${weight}`) => h({ weight, currency: 'USD', symbol });
    // exactly 50 % foreign is not "high", but all of it in one currency is a large single exposure
    expect(ids([usd(0.2), usd(0.2), usd(0.1), filler(0.25), filler(0.25)])).toEqual(['currency-concentration']);
    expect(ids([usd(0.2), usd(0.21), filler(0.25), filler(0.25), filler(0.09)])).toEqual(['currency-concentration']);
    expect(ids([usd(0.2), usd(0.2), filler(0.25), filler(0.25), filler(0.1)])).toEqual([]);
    const exposed = generateInsights([usd(0.17, 'A'), usd(0.17, 'B'), usd(0.17, 'C'), filler(0.25), filler(0.24)], noIncome);
    expect(exposed).toEqual([
      expect.objectContaining({ id: 'fx-exposure', severity: 'warning', title: 'High currency exposure', symbols: ['A', 'B', 'C'] }),
    ]);
    // one foreign-currency exposure insight at a time
    expect(exposed.map((i) => i.id)).not.toContain('currency-concentration');
  });

  it('splits foreign exposure across currencies', () => {
    const f = (weight: number, currency: string) => h({ weight, currency, symbol: currency + weight });
    expect(ids([f(0.17, 'USD'), f(0.17, 'USD'), f(0.17, 'GBP'), filler(0.25), filler(0.24)])).toEqual(['fx-exposure']);
  });

  it('flags small positions that are deep in the red (strict thresholds)', () => {
    const base = [filler(0.2), filler(0.2), filler(0.2), filler(0.2)];
    const loser = (weight: number, pct: number, symbol: string) => h({ weight, unrealizedPnlPct: pct, symbol });
    expect(ids([...base, filler(0.1), loser(0.02, -40, 'X')])).toEqual([]);
    expect(ids([...base, filler(0.1), loser(0.0199, -15, 'X')])).toEqual([]);
    const one = generateInsights([...base, filler(0.1), loser(0.0199, -15.01, 'X')], noIncome);
    expect(one).toEqual([
      expect.objectContaining({ id: 'dead-weight', severity: 'info', title: 'A small position is deep in the red', symbols: ['X'], detail: expect.stringContaining('X is down more than 15%') }),
    ]);
    const two = generateInsights([...base, loser(0.01, -50, 'Z'), loser(0.01, -20, 'Y')], noIncome);
    expect(two[0]).toMatchObject({ title: '2 small positions are deep in the red', symbols: ['Y', 'Z'], detail: expect.stringContaining('Y, Z are down more than 15% yet make up under 2%') });
  });

  it('flags income relying on one holding above 40 %', () => {
    const holdings = [filler(0.2), filler(0.2), filler(0.2), filler(0.2), filler(0.2)];
    const incomeOf = (sharePct: number): PassiveIncome => ({
      ...noIncome,
      forward12m: 100,
      holdings: [{ symbol: 'PAY', name: 'Payer', declared: 0, estimated: 100, total: 100, sharePct, yieldPct: 1, yieldOnCostPct: 1 }],
    });
    expect(ids(holdings, incomeOf(40))).toEqual([]);
    expect(generateInsights(holdings, incomeOf(40.01))).toEqual([
      expect.objectContaining({ id: 'income-concentration', severity: 'warning', title: 'Dividend income relies on PAY', symbols: ['PAY'], detail: expect.stringContaining('Payer provides 40% of your expected dividend income') }),
    ]);
    expect(ids(holdings, incomeOf(100))).toEqual(['income-concentration']);
  });

  it('lists warnings before infos', () => {
    const list = generateInsights(
      [h({ weight: 0.6, country: 'Netherlands', sector: 'Technology', symbol: 'TOP' }), h({ weight: 0.01, unrealizedPnlPct: -30 }), filler(0.39)],
      noIncome,
    );
    expect(list.map((i) => `${i.severity}:${i.id}`)).toEqual([
      'warning:concentration-top-holding',
      'warning:sector-imbalance',
      'info:country-concentration',
      'info:dead-weight',
    ]);
  });
});
