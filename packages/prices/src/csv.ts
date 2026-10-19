/**
 * Minimal RFC 4180 reader: quoted fields (commas, line breaks and `""` inside), CRLF or LF. Lines that are completely
 * empty are skipped, like Python's `csv.DictReader`.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let touched = false;

  const endField = (): void => {
    row.push(field);
    field = '';
    touched = true;
  };
  const endRow = (): void => {
    if (touched || field !== '') {
      endField();
      rows.push(row);
    }
    row = [];
    touched = false;
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (input[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') endField();
    else if (char === '\n') endRow();
    else if (char !== '\r') field += char;
  }
  endRow();
  return rows;
}

/** Rows as objects keyed by the header; a short row leaves the missing columns undefined. */
export function csvRecords(rows: readonly (readonly string[])[]): { header: string[]; records: Record<string, string | undefined>[] } {
  const [header = [], ...body] = rows;
  return { header: [...header], records: body.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index]]))) };
}
