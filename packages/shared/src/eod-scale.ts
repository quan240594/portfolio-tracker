/**
 * Scale and currency alignment of stored end-of-day rows.
 *
 * Providers do not say in which unit an exchange-listed close is quoted, so the price service labels every London row `GBX` (pence)
 * and divides it by 100. A London line quoted in USD or in pounds is then stored a hundred times too small (or large) and labelled
 * GBP, so a position valued on it is nearly worth nothing on every day but the last one, which uses the live quote of the broker.
 * A real day-to-day move is never near 100 times, so such a row is recognisable: against the neighbouring rows (a break in the
 * series) and against the stored live quote (the anchor of the newest row). Idempotent: aligned rows are returned unchanged.
 */
import type { EodPrice, Quote } from './types.js';

/** A ratio within this factor of exactly 100 (or 1/100) is a unit mix-up; the margin covers FX moves between currencies and price moves. */
export const SCALE_MARGIN = 2;
const SCALE = 100;

/** The power of 100 by which `ratio` (a close over its reference) is off: 1 (too high), -1 (too low) or 0 (consistent). */
function scaleExponent(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio >= SCALE / SCALE_MARGIN && ratio <= SCALE * SCALE_MARGIN) return 1;
  if (ratio >= 1 / (SCALE * SCALE_MARGIN) && ratio <= SCALE_MARGIN / SCALE) return -1;
  return 0;
}

/** Exponent of each row (ascending order): the power of 100 its close is too high by, judged from the newer neighbour and the quote. */
function exponents(rows: readonly EodPrice[], quote: Quote | undefined): number[] {
  const out = new Array<number>(rows.length).fill(0);
  const newest = rows.at(-1)!;
  if (quote !== undefined && quote.price > 0 && newest.close > 0) out[rows.length - 1] = scaleExponent(newest.close / quote.price);
  for (let i = rows.length - 2; i >= 0; i--) {
    const here = rows[i]!.close;
    const next = rows[i + 1]!.close;
    out[i] = out[i + 1]! + (here > 0 && next > 0 ? scaleExponent(here / next) : 0);
  }
  return out;
}

/**
 * The rows with every close that is a power of 100 off its neighbours or off the live `quote` rescaled to the unit of the newest
 * rows, and relabelled with the currency of the quote (or of the newest row without one). Rows are returned in ascending date order.
 */
export function alignEodScale(rows: readonly EodPrice[], quote?: Quote): EodPrice[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return sorted;
  const exponent = exponents(sorted, quote);
  if (exponent.every((e) => e === 0)) return sorted;
  const currency = quote?.currency ?? sorted.at(-1)!.currency;
  return sorted.map((row, i) => (exponent[i] === 0 ? row : { ...row, close: row.close / SCALE ** exponent[i]!, currency }));
}
