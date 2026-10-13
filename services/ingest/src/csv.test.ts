import { describe, expect, it } from 'vitest';
import { MAX_ROWS, parseImportCsv } from './csv.js';

describe('parseImportCsv', () => {
  it('accepts case-insensitive headers in any order, trims values and defaults an empty fee', () => {
    const res = parseImportCsv('\uFEFFSymbol, Date ,TYPE,quantity,price,FEE,currency,note\n aapl ,2025-01-02, buy ,10,150.5,,usd,first\n\n');
    expect(res).toEqual({
      ok: true,
      rowCount: 1,
      rows: [{ row: 1, input: { symbol: 'AAPL', date: '2025-01-02', type: 'BUY', quantity: 10, price: 150.5, fee: 0, currency: 'USD', note: 'first' } }],
    });
  });

  it('works without the optional note column', () => {
    const res = parseImportCsv('date,type,symbol,quantity,price,fee,currency\n2025-01-02,BUY,ASML.AS,1,600,1,EUR\n');
    expect(res.ok).toBe(true);
  });

  it('reports missing required columns as row 0', () => {
    const res = parseImportCsv('date,type,symbol,quantity\n2025-01-02,BUY,AAPL,1\n');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toMatchObject({ row: 0, message: expect.stringContaining('price, fee, currency') });
  });

  it('reports every invalid row with 1-based row numbers', () => {
    const csv = 'date,type,symbol,quantity,price,fee,currency\n2025-01-02,BUY,AAPL,1,1,0,USD\n13/01/2025,HOLD,AAPL,-1,1,0,USD\n2025-01-03,BUY,AAPL,1,abc,0,USD\n';
    const res = parseImportCsv(csv);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.rowCount).toBe(3);
      expect(res.errors.map((e) => e.row)).toEqual([2, 3]);
      expect(res.errors[0]!.message).toMatch(/date/);
    }
  });

  it('rejects empty files and too many rows', () => {
    expect(parseImportCsv('date,type,symbol,quantity,price,fee,currency\n').ok).toBe(false);
    const big = 'date,type,symbol,quantity,price,fee,currency\n' + '2025-01-02,BUY,AAPL,1,1,0,USD\n'.repeat(MAX_ROWS + 1);
    const res = parseImportCsv(big);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]!.message).toMatch(/Too many rows/);
  });

  it('reports malformed CSV', () => {
    const res = parseImportCsv('date,type\n"unterminated,BUY\n');
    expect(res.ok).toBe(false);
  });
});
