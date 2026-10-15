import { buildPositions, type SymbolMapping, type Transaction } from '@portfolio/shared';
import { resolveSymbols } from './symbols.js';
import type { Trading212Api } from './t212/client.js';

export interface PositionMismatch {
  symbol: string;
  /** Quantity replayed from the imported transactions. */
  expected: number;
  /** Quantity Trading 212 reports as open. */
  actual: number;
}

export interface Reconciliation {
  matched: number;
  mismatched: PositionMismatch[];
  /** Open Trading 212 instruments without a symbol mapping (not comparable). */
  unmapped: string[];
}

/** Fractional quantities arrive with 8 decimals; anything below this is rounding noise. */
export const QUANTITY_TOLERANCE = 1e-6;

const close = (a: number, b: number) => Math.abs(a - b) <= QUANTITY_TOLERANCE;

/** Compares the open positions reported by Trading 212 with the positions replayed from `transactions`. */
export async function reconcilePositions(
  api: Pick<Trading212Api, 'positions' | 'instruments' | 'exchanges'>,
  transactions: readonly Transaction[],
  overrides: Readonly<Record<string, string>>,
  loadExchanges: () => Promise<Map<string, string>>,
): Promise<Reconciliation> {
  const { items } = await api.positions();
  const mappings: Map<string, SymbolMapping> = await resolveSymbols(
    items.map((p) => ({ ticker: p.instrument.ticker, isin: p.instrument.isin, currency: p.instrument.currency })),
    overrides,
    loadExchanges,
  );
  const actual = new Map<string, number>();
  const unmapped: string[] = [];
  for (const { instrument, quantity } of items) {
    const mapping = mappings.get(instrument.ticker);
    if (mapping?.ok) actual.set(mapping.symbol, (actual.get(mapping.symbol) ?? 0) + quantity);
    else unmapped.push(instrument.ticker);
  }

  const expected = new Map<string, number>();
  for (const [symbol, position] of buildPositions(transactions)) expected.set(symbol, position.quantity);
  const symbols = [...new Set([...actual.keys(), ...expected.keys()])].sort((a, b) => a.localeCompare(b));
  const mismatched: PositionMismatch[] = [];
  let matched = 0;
  for (const symbol of symbols) {
    const e = expected.get(symbol) ?? 0;
    const a = actual.get(symbol) ?? 0;
    if (close(e, a)) {
      if (a > 0) matched++;
    } else mismatched.push({ symbol, expected: e, actual: a });
  }
  const sortedUnmapped = [...unmapped].sort((x, y) => x.localeCompare(y));
  return { matched, mismatched, unmapped: sortedUnmapped };
}
