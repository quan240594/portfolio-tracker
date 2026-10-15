import { isMarketSymbol, type ClosedSecurity, type Holding } from '@portfolio/shared';

export type SecuritySortKey = 'symbol' | 'sector' | 'country' | 'currency' | 'quantity' | 'marketValue' | 'pnlPct' | 'weight';
export type SortDir = 'asc' | 'desc';

/** One line of "Securities in your portfolio": an open holding, or (optionally) a sold-out position. */
export interface SecurityRow {
  symbol: string;
  name: string;
  sector: string;
  country: string;
  currency: string;
  quantity: number;
  /** Base currency; 0 for a sold position. */
  marketValue: number;
  /** Unrealised P/L % of an open holding, total return % (realised + dividends) of a sold one. */
  pnlPct: number;
  pnl: number;
  /** 0..1 share of the portfolio value; 0 for a sold position. */
  weight: number;
  sold: boolean;
  stale: boolean;
}

const fromHolding = (h: Holding): SecurityRow => ({
  symbol: h.symbol,
  name: h.name,
  sector: h.sector,
  country: h.country,
  currency: h.currency,
  quantity: h.quantity,
  marketValue: h.marketValue,
  pnlPct: h.unrealizedPnlPct,
  pnl: h.unrealizedPnl,
  weight: h.weight,
  sold: false,
  stale: h.priceStale,
});

const fromClosed = (c: ClosedSecurity): SecurityRow => ({
  symbol: c.symbol,
  name: c.name,
  sector: c.sector,
  country: c.country,
  currency: c.currency,
  quantity: 0,
  marketValue: 0,
  pnlPct: c.profitPct,
  pnl: c.profit,
  weight: 0,
  sold: true,
  stale: false,
});

/**
 * Market securities of the current holdings (cash and custom assets are not securities), plus the sold-out positions
 * that are not held in the scope any more when `includeSold` is on.
 */
export function buildSecurityRows(holdings: readonly Holding[], closed: readonly ClosedSecurity[] | undefined, includeSold: boolean): SecurityRow[] {
  const open = holdings.filter((h) => isMarketSymbol(h.symbol)).map(fromHolding);
  if (!includeSold || !closed) return open;
  const held = new Set(open.map((r) => r.symbol));
  return [...open, ...closed.filter((c) => !held.has(c.symbol)).map(fromClosed)];
}

/** Case-insensitive match of the query on symbol, name, sector and country. */
export function filterSecurities(rows: readonly SecurityRow[], query: string): SecurityRow[] {
  const q = query.trim().toLocaleLowerCase('en');
  if (q === '') return [...rows];
  return rows.filter((r) => [r.symbol, r.name, r.sector, r.country].some((v) => v.toLocaleLowerCase('en').includes(q)));
}

const TEXT_KEYS: ReadonlySet<SecuritySortKey> = new Set(['symbol', 'sector', 'country', 'currency']);

export function sortSecurities(rows: readonly SecurityRow[], key: SecuritySortKey, dir: SortDir): SecurityRow[] {
  const m = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const cmp = TEXT_KEYS.has(key) ? String(a[key]).localeCompare(String(b[key])) : Number(a[key]) - Number(b[key]);
    return cmp * m || a.symbol.localeCompare(b.symbol);
  });
}
