import { normalizeDecimalInput } from '../../lib/format';

/** Parses a typed decimal (Dutch or plain); `undefined` for empty or non-numeric input. */
export function parseNumber(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(normalizeDecimalInput(raw));
  return Number.isFinite(n) ? n : undefined;
}

export const numberToInput = (n: number | undefined): string => (n === undefined ? '' : String(n));

/** Saves `text` as a file through a temporary link (browser download). */
export function downloadFile(fileName: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
