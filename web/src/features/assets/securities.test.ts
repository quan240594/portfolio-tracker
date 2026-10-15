import type { ClosedSecurity, Holding } from '@portfolio/shared';
import { buildSecurityRows, filterSecurities, sortSecurities } from './securities';

const holding = (over: Partial<Holding>): Holding => ({
  symbol: 'AAA',
  name: 'Alpha Inc',
  assetClass: 'STOCK',
  sector: 'Technology',
  country: 'United States',
  currency: 'USD',
  quantity: 10,
  averageCostLocal: 10,
  priceLocal: 12,
  averageCostBase: 8,
  priceBase: 9,
  priceStale: false,
  costBasis: 80,
  marketValue: 90,
  unrealizedPnl: 10,
  unrealizedPnlPct: 12.5,
  currencyEffect: 0,
  dayChange: 0,
  dayChangePct: 0,
  realizedPnl: 0,
  dividendsReceived: 0,
  weight: 0.5,
  ...over,
});

const closed = (over: Partial<ClosedSecurity>): ClosedSecurity => ({
  symbol: 'OLD',
  name: 'Old Co',
  assetClass: 'STOCK',
  sector: 'Energy',
  country: 'Germany',
  currency: 'EUR',
  realizedPnl: 5,
  dividendsReceived: 1,
  profit: 6,
  profitPct: 6,
  lastSoldDate: '2026-03-01',
  ...over,
});

const held = [
  holding({}),
  holding({ symbol: 'BBB', name: 'Beta Corp', sector: 'Energy', country: 'Netherlands', currency: 'EUR', marketValue: 300, unrealizedPnlPct: -3, weight: 0.4, priceStale: true }),
  holding({ symbol: 'CASH.EUR', name: 'Cash', assetClass: 'CASH' }),
  holding({ symbol: 'CUSTOM:abc', name: 'House', assetClass: 'REAL_ESTATE' }),
];

describe('securities', () => {
  it('keeps market securities only and maps the holding fields', () => {
    const rows = buildSecurityRows(held, undefined, false);
    expect(rows.map((r) => r.symbol)).toEqual(['AAA', 'BBB']);
    expect(rows[0]).toMatchObject({ name: 'Alpha Inc', quantity: 10, marketValue: 90, pnlPct: 12.5, pnl: 10, weight: 0.5, sold: false, stale: false });
    expect(rows[1]!.stale).toBe(true);
  });

  it('adds sold positions only when asked and not held any more', () => {
    const sold = [closed({}), closed({ symbol: 'AAA' })];
    expect(buildSecurityRows(held, sold, false).map((r) => r.symbol)).toEqual(['AAA', 'BBB']);
    expect(buildSecurityRows(held, undefined, true).map((r) => r.symbol)).toEqual(['AAA', 'BBB']);
    const rows = buildSecurityRows(held, sold, true);
    expect(rows.map((r) => r.symbol)).toEqual(['AAA', 'BBB', 'OLD']);
    expect(rows[2]).toMatchObject({ sold: true, quantity: 0, marketValue: 0, pnlPct: 6, pnl: 6, weight: 0 });
  });

  it('filters on symbol, name, sector and country, ignoring case', () => {
    const rows = buildSecurityRows(held, undefined, false);
    expect(filterSecurities(rows, '  ')).toHaveLength(2);
    expect(filterSecurities(rows, 'beta').map((r) => r.symbol)).toEqual(['BBB']);
    expect(filterSecurities(rows, 'ENERGY').map((r) => r.symbol)).toEqual(['BBB']);
    expect(filterSecurities(rows, 'united').map((r) => r.symbol)).toEqual(['AAA']);
    expect(filterSecurities(rows, 'aaa').map((r) => r.symbol)).toEqual(['AAA']);
    expect(filterSecurities(rows, 'zzz')).toEqual([]);
  });

  it('sorts text with localeCompare and numbers numerically, without touching the input', () => {
    const rows = buildSecurityRows(held, [closed({})], true);
    const before = rows.map((r) => r.symbol);
    expect(sortSecurities(rows, 'marketValue', 'desc').map((r) => r.symbol)).toEqual(['BBB', 'AAA', 'OLD']);
    expect(sortSecurities(rows, 'marketValue', 'asc').map((r) => r.symbol)).toEqual(['OLD', 'AAA', 'BBB']);
    expect(sortSecurities(rows, 'country', 'asc').map((r) => r.symbol)).toEqual(['OLD', 'BBB', 'AAA']);
    expect(sortSecurities(rows, 'symbol', 'desc').map((r) => r.symbol)).toEqual(['OLD', 'BBB', 'AAA']);
    expect(sortSecurities(rows, 'currency', 'asc').map((r) => r.symbol)).toEqual(['BBB', 'OLD', 'AAA']);
    expect(sortSecurities(rows, 'pnlPct', 'asc').map((r) => r.symbol)).toEqual(['BBB', 'OLD', 'AAA']);
    // equal keys fall back to the symbol
    expect(sortSecurities(rows, 'sector', 'asc').map((r) => r.symbol)).toEqual(['BBB', 'OLD', 'AAA']);
    expect(rows.map((r) => r.symbol)).toEqual(before);
  });
});
