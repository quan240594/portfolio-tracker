/** Synthetic Snowball "Holdings" exports for tests: invented tickers, names and values only. */
const HEADER = ['Holding', "Holdings' name", 'Shares', 'Currency', 'Country', 'Sector', 'Category', 'ISIN'];

export interface SnowballFixtureRow {
  holding: string;
  name?: string;
  currency?: string;
  country?: string;
  sector?: string;
  category?: string;
  isin?: string;
}

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

export function snowballCsv(rows: readonly SnowballFixtureRow[]): string {
  const lines = rows.map((r) => [r.holding, r.name ?? '', '10', r.currency ?? '', r.country ?? '', r.sector ?? '', r.category ?? '', r.isin ?? ''].map(quote).join(','));
  return [HEADER.map(quote).join(','), ...lines].join('\r\n') + '\r\n';
}

export const snowballFile = (rows: readonly SnowballFixtureRow[], name = 'holdings.csv'): File => new File([snowballCsv(rows)], name, { type: 'text/csv' });

/** Matches the demo AAPL holding by ticker: same values as the demo profile, so it changes nothing. */
export const UNCHANGED_ROW: SnowballFixtureRow = { holding: 'AAPL', name: 'Apple Inc.', currency: 'USD', country: 'United States', sector: 'Technology', category: 'Technology' };
/** Matches the demo VWRL.AS holding by ticker and changes its sector and country. */
export const CHANGED_ROW: SnowballFixtureRow = { holding: 'VWRL', name: 'Invented World Fund', currency: 'EUR', country: 'Netherlands', sector: 'Funds', category: 'Funds' };
/** Not held. */
export const UNHELD_ROW: SnowballFixtureRow = { holding: 'ZZZZ', name: 'Invented Corp', currency: 'USD', country: 'Germany', sector: 'Utilities', category: 'Utilities' };
