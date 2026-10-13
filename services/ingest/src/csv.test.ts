import { describe, expect, it } from 'vitest';
import { MAX_ERRORS, MAX_ROWS, parseImportCsv } from './csv.js';

const HEADER = 'date,type,symbol,quantity,price,fee,currency';

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

  it('ignores unknown and blank header columns', () => {
    const res = parseImportCsv(`${HEADER},broker,\n2025-01-02,BUY,AAPL,1,1,0,USD,degiro,\n`);
    expect(res).toEqual({
      ok: true,
      rowCount: 1,
      rows: [{ row: 1, input: { date: '2025-01-02', type: 'BUY', symbol: 'AAPL', quantity: 1, price: 1, fee: 0, currency: 'USD' } }],
    });
  });

  it('rejects duplicate known columns, even when they differ only in case', () => {
    const res = parseImportCsv('date,Date,type,symbol,quantity,price,fee,currency,CURRENCY\n2025-01-02,2025-01-03,BUY,AAPL,1,1,0,USD,EUR\n');
    expect(res).toEqual({ ok: false, rowCount: 1, errors: [{ row: 0, message: 'Duplicate column(s): date, currency' }] });
  });

  it('allows unknown columns to repeat', () => {
    expect(parseImportCsv(`${HEADER},x,x\n2025-01-02,BUY,AAPL,1,1,0,USD,a,b\n`).ok).toBe(true);
  });

  it('reports a short row as a row-level error instead of a missing header column', () => {
    const res = parseImportCsv(`${HEADER}\n2025-01-02,BUY,AAPL\n2025-01-03,BUY,AAPL,1,1,0,USD\n`);
    expect(res).toEqual({ ok: false, rowCount: 2, errors: [{ row: 1, message: 'Expected 7 fields but found 3' }] });
  });

  it('rejects an extra field caused by an unquoted comma in the note instead of truncating it', () => {
    const res = parseImportCsv(`${HEADER},note\n2025-01-02,BUY,AAPL,1,1,0,USD,ok\n2025-01-03,BUY,AAPL,1,1,0,USD,bought dip, again\n`);
    expect(res).toEqual({
      ok: false,
      rowCount: 2,
      errors: [{ row: 2, message: 'Expected 8 fields but found 9 — quote values containing commas' }],
    });
  });

  it('accepts a quoted note containing commas', () => {
    const res = parseImportCsv(`${HEADER},note\n2025-01-02,BUY,AAPL,1,1,0,USD,"bought dip, again"\n`);
    expect(res).toMatchObject({ ok: true, rows: [{ row: 1, input: { note: 'bought dip, again' } }] });
  });

  it('reports field-count errors alongside validation errors, in row order', () => {
    const res = parseImportCsv(`${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD,extra\n2025-01-02,BUY,AAPL,x,1,0,USD\n2025-01-02,BUY\n`);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.map((e) => e.row)).toEqual([1, 2, 3]);
      expect(res.errors[0]!.message).toBe('Expected 7 fields but found 8 — quote values containing commas');
      expect(res.errors[1]!.message).toMatch(/^quantity: /);
      expect(res.errors[2]!.message).toBe('Expected 7 fields but found 2');
    }
  });

  it('ignores blank lines, including trailing ones, without shifting row numbers', () => {
    const res = parseImportCsv(`${HEADER}\n\n2025-01-02,BUY,AAPL,1,1,0,USD\r\n\r\n2025-01-03,BUY,AAPL,0,1,0,USD\n\n\n`);
    expect(res).toEqual({ ok: false, rowCount: 2, errors: [{ row: 2, message: expect.stringMatching(/^quantity: /) }] });
  });

  it('accepts trailing commas when the header has a matching blank column', () => {
    expect(parseImportCsv(`${HEADER},\n2025-01-02,BUY,AAPL,1,1,0,USD,\n`).ok).toBe(true);
  });

  it('strips a UTF-8 BOM before the first header name', () => {
    const res = parseImportCsv(`\uFEFF${HEADER}\n2025-01-02,BUY,AAPL,1,1,0,USD\n`);
    expect(res.ok).toBe(true);
  });

  it('treats a completely empty or BOM-only file as having no data rows', () => {
    for (const content of ['', '\uFEFF', '\n\n']) {
      expect(parseImportCsv(content)).toEqual({ ok: false, rowCount: 0, errors: [{ row: 0, message: 'CSV contains no data rows' }] });
    }
  });

  it('accepts exactly MAX_ROWS rows', () => {
    const res = parseImportCsv(`${HEADER}\n` + '2025-01-02,BUY,AAPL,1,1,0,USD\n'.repeat(MAX_ROWS));
    expect(res).toMatchObject({ ok: true, rowCount: MAX_ROWS });
  });

  it('reports the row count and caps errors at MAX_ERRORS', () => {
    const res = parseImportCsv(`${HEADER}\n` + '2025-01-02,BUY,AAPL,0,1,0,USD\n'.repeat(MAX_ERRORS + 20));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.rowCount).toBe(MAX_ERRORS + 20);
      expect(res.errors).toHaveLength(MAX_ERRORS);
      expect(res.errors.at(-1)!.row).toBe(MAX_ERRORS);
      expect(res.errors[0]!.message).toMatch(/^quantity: /);
    }
  });

  it('prefixes malformed CSV errors and reports them as row 0', () => {
    expect(parseImportCsv('date,type\n"unterminated,BUY\n')).toEqual({
      ok: false,
      rowCount: 0,
      errors: [{ row: 0, message: expect.stringMatching(/^Malformed CSV: /) }],
    });
  });
});
