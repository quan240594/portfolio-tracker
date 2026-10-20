/**
 * Snowball "Holdings" export -> normalised classification rows (`ClassificationRow`), parsed in the browser like the Trading 212
 * converter (`broker-csv.ts`); the server only matches the rows to the user's instruments and stores the overrides.
 *
 * Columns used: Holding (ticker), Holdings' name, Sector, Country, Category, ISIN, Currency. Every other column is ignored; a column
 * name that occurs twice (Snowball repeats some) is read from its first occurrence. Pure and deterministic.
 *
 * Snowball's Category is the owner's own grouping and mixes asset kinds ("Funds", "Commodities", "Crypto") with sectors, so the
 * asset class comes from the Category (the Sector column when the Category is empty) through the tables below. Sector and
 * Country labels are mapped to the vocabulary the market-data providers (and so the allocation views) use; a label that is in none
 * of the tables is kept as written.
 */
import { parseCsvText } from './broker-csv.js';
import type { ClassificationRow } from './classification.js';
import type { AssetClass } from './types.js';

/** Category (lower case) -> asset class. A GICS sector name in the Category means a company share, see `GICS_SECTORS`. */
export const SNOWBALL_CATEGORY_CLASS: Readonly<Record<string, AssetClass>> = {
  funds: 'ETF',
  fund: 'ETF',
  etfs: 'ETF',
  etf: 'ETF',
  commodities: 'COMMODITY',
  commodity: 'COMMODITY',
  crypto: 'CRYPTO',
  cryptocurrencies: 'CRYPTO',
  cryptocurrency: 'CRYPTO',
  bonds: 'BOND',
  bond: 'BOND',
  cash: 'CASH',
};

/** Snowball's (GICS) sector names (lower case) -> the sector name of the app (the providers' vocabulary). */
export const SNOWBALL_SECTORS: Readonly<Record<string, string>> = {
  'information technology': 'Technology',
  technology: 'Technology',
  healthcare: 'Healthcare',
  'health care': 'Healthcare',
  financials: 'Financial Services',
  financial: 'Financial Services',
  'consumer discretionary': 'Consumer Cyclical',
  'consumer staples': 'Consumer Defensive',
  'communication services': 'Communication Services',
  industrials: 'Industrials',
  energy: 'Energy',
  materials: 'Basic Materials',
  'real estate': 'Real Estate',
  utilities: 'Utilities',
  funds: 'Diversified',
};

/** Sector of rows whose Snowball sector is the catch-all `Other`: named after their asset class. */
export const SNOWBALL_CLASS_SECTORS: Readonly<Partial<Record<AssetClass, string>>> = { CRYPTO: 'Digital Assets', COMMODITY: 'Commodities' };

/** Snowball country name (lower case) -> the country name of the app. Others are kept as written (`Other` included). */
export const SNOWBALL_COUNTRIES: Readonly<Record<string, string>> = {
  'united states of america': 'United States',
  usa: 'United States',
  us: 'United States',
  uk: 'United Kingdom',
  'great britain': 'United Kingdom',
  'korea, republic of': 'South Korea',
  'korea (south)': 'South Korea',
  'russian federation': 'Russia',
  'czechia': 'Czech Republic',
};

const SECTOR_LABELS = new Set(Object.keys(SNOWBALL_SECTORS).filter((label) => label !== 'funds'));

export interface SnowballIssue {
  /** 1-based line of the file (the header is line 1). */
  line: number;
  message: string;
}

export interface SnowballParse {
  rows: ClassificationRow[];
  /** Rows left out, and labels that had no mapping. */
  issues: SnowballIssue[];
}

const norm = (value: string): string => value.replaceAll('\u2019', "'").trim().toLowerCase();

const COLUMNS = { ticker: 'holding', name: "holdings' name", sector: 'sector', country: 'country', category: 'category', isin: 'isin', currency: 'currency' } as const;

/** Whether the header row is Snowball's holdings export. */
export function isSnowballHoldingsHeader(header: readonly string[]): boolean {
  const names = new Set(header.map(norm));
  return [COLUMNS.ticker, COLUMNS.name, COLUMNS.sector, COLUMNS.country, COLUMNS.isin].every((column) => names.has(column));
}

const clean = (value: string | undefined): string | undefined => (value === undefined || value.trim() === '' ? undefined : value.trim());

/** The asset class of a Category (else of the Sector), or undefined when neither says. */
export function snowballAssetClass(category: string | undefined, sector: string | undefined): AssetClass | undefined {
  const label = norm(category ?? '');
  if (label !== '') return SNOWBALL_CATEGORY_CLASS[label] ?? (SECTOR_LABELS.has(label) ? 'STOCK' : undefined);
  const fromSector = norm(sector ?? '');
  if (fromSector === 'funds') return 'ETF';
  return SECTOR_LABELS.has(fromSector) ? 'STOCK' : undefined;
}

export function snowballSector(sector: string | undefined, assetClass: AssetClass | undefined): string | undefined {
  const label = clean(sector);
  if (label === undefined) return assetClass === undefined ? undefined : SNOWBALL_CLASS_SECTORS[assetClass];
  if (norm(label) === 'other') return (assetClass === undefined ? undefined : SNOWBALL_CLASS_SECTORS[assetClass]) ?? label;
  return SNOWBALL_SECTORS[norm(label)] ?? label;
}

export function snowballCountry(country: string | undefined): string | undefined {
  const label = clean(country);
  return label === undefined ? undefined : (SNOWBALL_COUNTRIES[norm(label)] ?? label);
}

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const CURRENCY = /^[A-Za-z]{3}$/;

function toRow(get: (column: keyof typeof COLUMNS) => string | undefined, line: number, issues: SnowballIssue[]): ClassificationRow | undefined {
  const ticker = clean(get('ticker'))?.toUpperCase();
  if (ticker === undefined) {
    issues.push({ line, message: 'No ticker in the Holding column; row skipped' });
    return undefined;
  }
  const category = clean(get('category'));
  const assetClass = snowballAssetClass(category, get('sector'));
  if (category !== undefined && assetClass === undefined) issues.push({ line, message: `Category "${category}" is not a known asset kind; the asset class is left as it is` });
  const isin = clean(get('isin'))?.toUpperCase();
  const currency = clean(get('currency'));
  const name = clean(get('name'));
  const sector = snowballSector(get('sector'), assetClass);
  const country = snowballCountry(get('country'));
  return {
    ticker,
    ...(isin !== undefined && ISIN.test(isin) ? { isin } : {}),
    ...(currency !== undefined && CURRENCY.test(currency) ? { currency: currency.toUpperCase() } : {}),
    ...(name === undefined ? {} : { name }),
    ...(assetClass === undefined ? {} : { assetClass }),
    ...(sector === undefined ? {} : { sector }),
    ...(country === undefined ? {} : { country }),
  };
}

/** Parses the export; an empty or foreign file gives no rows and one issue. */
export function parseSnowballHoldings(text: string): SnowballParse {
  const table = parseCsvText(text);
  const header = table[0] ?? [];
  if (!isSnowballHoldingsHeader(header)) return { rows: [], issues: [{ line: 1, message: 'Not a Snowball holdings export (Holding, Holdings\' name, Sector, Country and ISIN columns are expected)' }] };
  const names = header.map(norm);
  const index = Object.fromEntries(Object.entries(COLUMNS).map(([key, column]) => [key, names.indexOf(column)])) as Record<keyof typeof COLUMNS, number>;
  const issues: SnowballIssue[] = [];
  const rows: ClassificationRow[] = [];
  // Blank lines are dropped by the parser, so the line numbers count the data rows (header = line 1).
  table.slice(1).forEach((cells, position) => {
    const row = toRow((column) => (index[column] < 0 ? undefined : cells[index[column]]), position + 2, issues);
    if (row !== undefined) rows.push(row);
  });
  return { rows, issues };
}
