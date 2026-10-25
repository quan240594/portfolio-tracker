import { describe, expect, it } from 'vitest';
import { alignEodScale } from './eod-scale.js';
import type { EodPrice, Quote } from './types.js';

const row = (date: string, close: number, currency = 'GBP', source?: string): EodPrice => ({ symbol: 'IITU.L', date, close, currency, ...(source ? { source } : {}) });
const quote = (price: number, currency = 'USD'): Quote => ({ symbol: 'IITU.L', price, previousClose: price, currency, asOf: '2026-06-15T10:00:00Z', source: 't212' });
const dates = ['2026-06-10', '2026-06-11', '2026-06-12'];

describe('alignEodScale', () => {
  it('returns consistent rows unchanged (sorted), also next to a live quote of the same size', () => {
    const rows = [row('2026-06-12', 51, 'USD'), row('2026-06-10', 49.5, 'USD'), row('2026-06-11', 50, 'USD')];
    const out = alignEodScale(rows, quote(52));
    expect(out.map((r) => r.date)).toEqual(dates);
    expect(out[0]).toBe(rows[1]);
    expect(alignEodScale([])).toEqual([]);
  });

  it('rescales a whole history stored 100 times too small (a USD line taken for pence) against the live quote and takes its currency', () => {
    const out = alignEodScale(dates.map((d, i) => row(d, 0.5 + i / 100)), quote(52));
    expect(out.map((r) => r.close)).toEqual([50, 51, 52]);
    expect(out.every((r) => r.currency === 'USD')).toBe(true);
  });

  it('divides a history stored 100 times too high', () => {
    const out = alignEodScale(dates.map((d, i) => row(d, 5000 + i * 100, 'GBP')), quote(52, 'GBP'));
    expect(out.map((r) => r.close)).toEqual([50, 51, 52]);
  });

  it('fixes only the rows that break from the newest ones: provider rows too small next to correct broker rows', () => {
    const rows = [row('2026-06-09', 0.49), row('2026-06-10', 0.5), row('2026-06-11', 50.5, 'USD', 't212'), row('2026-06-12', 51, 'USD', 't212')];
    const out = alignEodScale(rows);
    expect(out.map((r) => r.close)).toEqual([49, 50, 50.5, 51]);
    expect(out.map((r) => r.currency)).toEqual(['USD', 'USD', 'USD', 'USD']);
    expect(out[2]).toBe(rows[2]);
    expect(out[3]).toBe(rows[3]);
  });

  it('takes the currency of the quote for the rescaled rows, also next to broker rows', () => {
    const rows = [row('2026-06-10', 0.5), row('2026-06-12', 51, 'EUR', 't212')];
    expect(alignEodScale(rows, quote(52, 'USD')).map((r) => r.currency)).toEqual(['USD', 'EUR']);
  });

  it('cannot tell a uniformly mis-scaled history without a quote, and tolerates real moves and bad closes', () => {
    const uniform = dates.map((d) => row(d, 0.5));
    expect(alignEodScale(uniform)).toEqual(uniform);
    const moves = [row('2026-06-10', 100), row('2026-06-11', 60), row('2026-06-12', 150)];
    expect(alignEodScale(moves, quote(140))).toEqual(moves);
    const bad = [row('2026-06-10', 0), row('2026-06-11', Number.NaN), row('2026-06-12', 50)];
    expect(alignEodScale(bad, quote(0))).toEqual(bad);
    expect(alignEodScale([row('2026-06-12', 0)], quote(52))).toEqual([row('2026-06-12', 0)]);
  });

  it('is idempotent', () => {
    const once = alignEodScale(dates.map((d, i) => row(d, 0.5 + i / 100)), quote(52));
    expect(alignEodScale(once, quote(52))).toEqual(once);
  });
});
