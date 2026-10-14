import { convertTrading212Csv, isTrading212Header, parseCsvText, type T212CsvConversion } from '@portfolio/shared';

export interface PreparedCsv {
  /** The file to upload: the original, or the converted Trading 212 export. */
  file: File;
  /** Set when the file was recognised as a Trading 212 history export. */
  conversion?: Omit<T212CsvConversion, 'csv'>;
}

/**
 * Recognises a Trading 212 "History" export by its header and converts it to the app's import format in the browser
 * (nothing is uploaded unconverted). Any other file is passed through untouched.
 */
export async function prepareImportFile(file: File): Promise<PreparedCsv> {
  const text = await file.text();
  const header = parseCsvText(text.slice(0, 4096).split(/\r?\n/, 1)[0] ?? '')[0] ?? [];
  if (!isTrading212Header(header)) return { file };
  const { csv, ...conversion } = convertTrading212Csv(text);
  return { file: new File([csv], file.name, { type: 'text/csv' }), conversion };
}
