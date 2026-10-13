import { parse } from 'csv-parse/sync';
import { CSV_COLUMNS, csvRowSchema, type TransactionInput } from '@portfolio/shared';

export const MAX_ROWS = 5000;
export const MAX_ERRORS = 100;
const REQUIRED_COLUMNS = CSV_COLUMNS.filter((c) => c !== 'note');

export interface RowError {
  row: number;
  message: string;
}

export interface ParsedRow {
  /** 1-based data row number (header excluded). */
  row: number;
  input: TransactionInput;
}

export type CsvParseResult = { ok: true; rows: ParsedRow[]; rowCount: number } | { ok: false; errors: RowError[]; rowCount: number };

/** Parses and validates an import CSV. Header names are case-insensitive and order-independent. */
export function parseImportCsv(content: string): CsvParseResult {
  let lines: string[][];
  try {
    // Parsed as arrays (not `columns`) so rows whose field count differs from the header can be detected:
    // csv-parse would otherwise drop extra fields or leave missing ones undefined.
    lines = parse(content, { bom: true, trim: true, skip_empty_lines: true, relax_column_count: true });
  } catch (err) {
    return { ok: false, rowCount: 0, errors: [{ row: 0, message: `Malformed CSV: ${(err as Error).message}` }] };
  }

  const [rawHeader = [], ...records] = lines;
  const header = rawHeader.map((h) => h.toLowerCase());
  if (records.length === 0) {
    return { ok: false, rowCount: 0, errors: [{ row: 0, message: 'CSV contains no data rows' }] };
  }
  if (records.length > MAX_ROWS) {
    return { ok: false, rowCount: records.length, errors: [{ row: 0, message: `Too many rows: ${records.length} (max ${MAX_ROWS})` }] };
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    return {
      ok: false,
      rowCount: records.length,
      errors: [{ row: 0, message: `Missing required column(s): ${missing.join(', ')}. Expected header: ${CSV_COLUMNS.join(',')}` }],
    };
  }
  // A repeated column would make the row value ambiguous, so such headers are rejected.
  const known = header.filter((c) => (CSV_COLUMNS as readonly string[]).includes(c));
  const duplicates = [...new Set(known.filter((c, i) => known.indexOf(c) !== i))];
  if (duplicates.length) {
    return { ok: false, rowCount: records.length, errors: [{ row: 0, message: `Duplicate column(s): ${duplicates.join(', ')}` }] };
  }

  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];
  records.forEach((fields, i) => {
    if (fields.length !== header.length) {
      const hint = fields.length > header.length ? ' — quote values containing commas' : '';
      errors.push({ row: i + 1, message: `Expected ${header.length} fields but found ${fields.length}${hint}` });
      return;
    }
    const record = Object.fromEntries(header.map((name, j) => [name, fields[j]]));
    const result = csvRowSchema.safeParse(record);
    if (result.success) {
      rows.push({ row: i + 1, input: result.data });
    } else {
      const message = result.error.issues.map((iss) => `${iss.path.join('.') || 'row'}: ${iss.message}`).join('; ');
      errors.push({ row: i + 1, message });
    }
  });
  return errors.length
    ? { ok: false, rowCount: records.length, errors: errors.slice(0, MAX_ERRORS) }
    : { ok: true, rowCount: records.length, rows };
}
