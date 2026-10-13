import type { Holding } from '@portfolio/shared';

export type SortKey =
  | 'symbol'
  | 'quantity'
  | 'averageCostBase'
  | 'priceBase'
  | 'marketValue'
  | 'unrealizedPnl'
  | 'unrealizedPnlPct'
  | 'currencyEffect'
  | 'dayChange'
  | 'weight';
export type SortDir = 'asc' | 'desc';

/** Sorts on base-currency (EUR) values, so avg cost/price compare across trading currencies. */
export function sortHoldings(holdings: readonly Holding[], key: SortKey, dir: SortDir): Holding[] {
  const m = dir === 'asc' ? 1 : -1;
  return [...holdings].sort((a, b) => {
    const cmp = key === 'symbol' ? a.symbol.localeCompare(b.symbol) : a[key] - b[key];
    return cmp * m || a.symbol.localeCompare(b.symbol);
  });
}
