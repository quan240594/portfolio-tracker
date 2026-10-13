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
  let records: Record<string, string>[];
  try {
    records = parse<Record<string, string>>(content, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
  } catch (err) {
    return { ok: false, rowCount: 0, errors: [{ row: 0, message: `Malformed CSV: ${(err as Error).message}` }] };
  }

  if (records.length === 0) {
    return { ok: false, rowCount: 0, errors: [{ row: 0, message: 'CSV contains no data rows' }] };
  }
  if (records.length > MAX_ROWS) {
    return { ok: false, rowCount: records.length, errors: [{ row: 0, message: `Too many rows: ${records.length} (max ${MAX_ROWS})` }] };
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !(c in records[0]!));
  if (missing.length) {
    return {
      ok: false,
      rowCount: records.length,
      errors: [{ row: 0, message: `Missing required column(s): ${missing.join(', ')}. Expected header: ${CSV_COLUMNS.join(',')}` }],
    };
  }

  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];
  records.forEach((record, i) => {
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
