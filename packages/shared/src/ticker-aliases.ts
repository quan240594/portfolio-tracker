/**
 * How a suffixed listing (`FOO.DE`, `ASML.AS`) maps to the ticker US data sources know the company by. One table for every feature that
 * talks to a US-centred source: the SEC ticker map of the earnings summaries and the Alpha Vantage earnings calendar.
 */

/** Listing ticker (without suffix) to the ticker the SEC and Alpha Vantage know the company by. A match is still checked against the holding's name. */
export const TICKER_ALIASES: ReadonlyMap<string, string> = new Map([
  ['FOO', 'CRM'],
  ['M4I', 'MA'],
  ['NFC', 'NFLX'],
  ['ADB', 'ADBE'],
  ['APC', 'AAPL'],
  ['MSF', 'MSFT'],
  ['AMZ', 'AMZN'],
  ['ABEA', 'GOOGL'],
  ['FB2A', 'META'],
  ['NVD', 'NVDA'],
  ['TL0', 'TSLA'],
  ['NOVC', 'NVO'],
  ['TSFA', 'TSM'],
  ['CMC', 'JPM'],
]);

const NAME_NOISE = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'plc', 'nv', 'sa', 'ag', 'se', 'holding', 'holdings',
  'group', 'the', 'adr', 'class', 'ordinary', 'shares', 'common', 'stock', 'de', 'ads', 'sponsored',
]);

export function significantWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !NAME_NOISE.has(word));
}
