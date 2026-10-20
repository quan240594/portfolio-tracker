import { MAX_CLASSIFICATION_IMPORT_BYTES, MAX_CLASSIFICATION_IMPORT_ROWS, parseSnowballHoldings, type SnowballParse } from '@portfolio/shared';

export type SnowballFileResult = ({ ok: true } & SnowballParse) | { ok: false; message: string };

const MAX_MB = MAX_CLASSIFICATION_IMPORT_BYTES / 1_000_000;

/**
 * Reads a Snowball "Holdings" export in the browser and maps it to the normalised rows the API takes. Nothing is uploaded here;
 * a file over the API's limit is refused up front, and a file that yields no row (wrong export, empty) says why.
 */
export async function readSnowballFile(file: File): Promise<SnowballFileResult> {
  if (file.size > MAX_CLASSIFICATION_IMPORT_BYTES) return { ok: false, message: `The file is larger than ${MAX_MB} MB; the Snowball holdings export is much smaller.` };
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, message: 'The selected file could not be read.' };
  }
  const parsed = parseSnowballHoldings(text);
  if (parsed.rows.length === 0) return { ok: false, message: parsed.issues[0]?.message ?? 'The file has no rows to import.' };
  if (parsed.rows.length > MAX_CLASSIFICATION_IMPORT_ROWS) return { ok: false, message: `The file has more than ${MAX_CLASSIFICATION_IMPORT_ROWS} rows, which is more than one import takes.` };
  return { ok: true, ...parsed };
}
