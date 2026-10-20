import { describe, expect, it } from 'vitest';
import {
  SNOWBALL_CATEGORY_CLASS,
  SNOWBALL_COUNTRIES,
  SNOWBALL_SECTORS,
  isSnowballHoldingsHeader,
  parseSnowballHoldings,
  snowballAssetClass,
  snowballCountry,
  snowballSector,
} from './classification-csv.js';

/** The columns of a Snowball holdings export (names only: the values below are invented). */
const HEADER = [
  'Holding', "Holdings' name", 'Note', 'Shares', 'Currency', 'Cost basis', 'Current value', 'Share price', 'Cost per share', 'Country', 'Sector', 'PE', 'EPS', 'Payout',
  'Market cap, $', 'Beta', 'Expense ratio', 'Dividends', 'Dividends per share', 'Dividend yield', 'Dividend yield on cost', 'Dividend growth (5Y)', 'Rating',
  'Date of the next payment', 'Next payment', 'Ex-dividend date', 'Div. received', 'Tax', 'Capital gain', 'Capital gain', 'Realized P&L', 'Total profit', 'Total profit',
  'Daily', 'Daily', 'IRR', 'Share in portfolio', 'Target share in portfolio', 'Category', 'Share in category', 'ISIN', 'Target share in category', 'Maturity date',
  'Yield to maturity (average price)', 'Effective yield (average price)',
];

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

interface Fixture {
  holding: string;
  name?: string;
  currency?: string;
  country?: string;
  sector?: string;
  category?: string;
  isin?: string;
}

function line(row: Fixture): string {
  const cells = HEADER.map(() => '0');
  const set = (column: string, value: string | undefined): void => void (cells[HEADER.indexOf(column)] = value ?? '');
  set('Holding', row.holding);
  set("Holdings' name", row.name);
  set('Currency', row.currency);
  set('Country', row.country);
  set('Sector', row.sector);
  set('Category', row.category);
  set('ISIN', row.isin);
  return cells.map(quote).join(',');
}

const file = (...rows: Fixture[]): string => `\uFEFF${HEADER.map(quote).join(',')}\r\n${rows.map(line).join('\r\n')}\r\n`;

describe('parseSnowballHoldings', () => {
  it('maps a synthetic export row by row', () => {
    const csv = file(
      { holding: 'acme', name: 'Acme Software, Inc', currency: 'usd', country: 'United States of America', sector: 'Information Technology', category: 'Information Technology', isin: 'US0000000002' },
      { holding: 'WRLD', name: 'Invented World Fund', currency: 'EUR', country: 'Other', sector: 'Funds', category: 'Funds', isin: 'IE00INVENT01' },
      { holding: 'GOLD', name: 'Invented Gold Trust', currency: 'GBP', country: 'Other', sector: 'Other', category: 'Commodities', isin: 'JE00INVENT02' },
      { holding: 'COIN', name: 'Invented Coin', currency: 'USD', country: 'Other', sector: 'Other', category: 'Crypto' },
      { holding: 'UTIL', name: 'Invented Power', currency: 'EUR', country: 'Netherlands', sector: 'Utilities', category: 'Utilities', isin: 'NL0000000003' },
    );
    const { rows, issues } = parseSnowballHoldings(csv);
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      { ticker: 'ACME', isin: 'US0000000002', currency: 'USD', name: 'Acme Software, Inc', assetClass: 'STOCK', sector: 'Technology', country: 'United States' },
      { ticker: 'WRLD', isin: 'IE00INVENT01', currency: 'EUR', name: 'Invented World Fund', assetClass: 'ETF', sector: 'Diversified', country: 'Other' },
      { ticker: 'GOLD', isin: 'JE00INVENT02', currency: 'GBP', name: 'Invented Gold Trust', assetClass: 'COMMODITY', sector: 'Commodities', country: 'Other' },
      { ticker: 'COIN', currency: 'USD', name: 'Invented Coin', assetClass: 'CRYPTO', sector: 'Digital Assets', country: 'Other' },
      { ticker: 'UTIL', isin: 'NL0000000003', currency: 'EUR', name: 'Invented Power', assetClass: 'STOCK', sector: 'Utilities', country: 'Netherlands' },
    ]);
  });

  it('skips rows without a ticker, keeps unknown labels and reports unknown categories', () => {
    const { rows, issues } = parseSnowballHoldings(file({ holding: '', name: 'Nameless' }, { holding: 'ODD', category: 'Collectibles', sector: 'Luxury Goods', country: 'Narnia', isin: 'not an isin', currency: 'EURO' }));
    expect(rows).toEqual([{ ticker: 'ODD', sector: 'Luxury Goods', country: 'Narnia' }]);
    expect(issues).toEqual([
      { line: 2, message: 'No ticker in the Holding column; row skipped' },
      { line: 3, message: 'Category "Collectibles" is not a known asset kind; the asset class is left as it is' },
    ]);
  });

  it('refuses a file that is not a Snowball holdings export', () => {
    expect(parseSnowballHoldings('date,type,symbol\n2026-01-01,BUY,AAA')).toEqual({ rows: [], issues: [expect.objectContaining({ line: 1 })] });
    expect(parseSnowballHoldings('')).toEqual({ rows: [], issues: [expect.objectContaining({ line: 1 })] });
  });

  it('reads the columns it needs by name, in any order, with a typographic apostrophe', () => {
    const csv = ['Sector,ISIN,Country,Holding,Holdings\u2019 name', 'Healthcare,US0000000002,USA,hlth,Invented Health'].join('\n');
    expect(parseSnowballHoldings(csv).rows).toEqual([{ ticker: 'HLTH', isin: 'US0000000002', name: 'Invented Health', assetClass: 'STOCK', sector: 'Healthcare', country: 'United States' }]);
  });
});

describe('Snowball mapping tables', () => {
  it('recognises the header', () => {
    expect(isSnowballHoldingsHeader(HEADER)).toBe(true);
    expect(isSnowballHoldingsHeader(['Holding', 'Sector'])).toBe(false);
  });

  it('maps the Category, falling back to the Sector', () => {
    expect(Object.entries(SNOWBALL_CATEGORY_CLASS).map(([label, assetClass]) => `${label}=${assetClass}`)).toEqual([
      'funds=ETF', 'fund=ETF', 'etfs=ETF', 'etf=ETF', 'commodities=COMMODITY', 'commodity=COMMODITY', 'crypto=CRYPTO', 'cryptocurrencies=CRYPTO', 'cryptocurrency=CRYPTO', 'bonds=BOND', 'bond=BOND', 'cash=CASH',
    ]);
    expect(snowballAssetClass('Healthcare', undefined)).toBe('STOCK');
    expect(snowballAssetClass('Bonds', 'Other')).toBe('BOND');
    expect(snowballAssetClass('Mystery', 'Funds')).toBeUndefined();
    expect(snowballAssetClass(undefined, 'Funds')).toBe('ETF');
    expect(snowballAssetClass('', 'Energy')).toBe('STOCK');
    expect(snowballAssetClass(undefined, 'Other')).toBeUndefined();
    expect(snowballAssetClass(undefined, undefined)).toBeUndefined();
  });

  it('maps every GICS sector to the vocabulary of the providers', () => {
    expect(snowballSector('Information Technology', 'STOCK')).toBe('Technology');
    expect(snowballSector('Healthcare', 'STOCK')).toBe('Healthcare');
    expect(snowballSector('Financials', 'STOCK')).toBe('Financial Services');
    expect(snowballSector('Consumer Discretionary', 'STOCK')).toBe('Consumer Cyclical');
    expect(snowballSector('Consumer Staples', 'STOCK')).toBe('Consumer Defensive');
    expect(snowballSector('Communication Services', 'STOCK')).toBe('Communication Services');
    expect(snowballSector('Industrials', 'STOCK')).toBe('Industrials');
    expect(snowballSector('Energy', 'STOCK')).toBe('Energy');
    expect(snowballSector('Materials', 'STOCK')).toBe('Basic Materials');
    expect(snowballSector('Real Estate', 'STOCK')).toBe('Real Estate');
    expect(snowballSector('Utilities', 'STOCK')).toBe('Utilities');
    expect(snowballSector('Funds', 'ETF')).toBe('Diversified');
    expect(Object.keys(SNOWBALL_SECTORS)).toHaveLength(15);
  });

  it('names the catch-all sector after the asset class, and keeps unknown sectors as written', () => {
    expect(snowballSector('Other', 'CRYPTO')).toBe('Digital Assets');
    expect(snowballSector('Other', 'COMMODITY')).toBe('Commodities');
    expect(snowballSector('Other', 'STOCK')).toBe('Other');
    expect(snowballSector('Other', undefined)).toBe('Other');
    expect(snowballSector(undefined, 'CRYPTO')).toBe('Digital Assets');
    expect(snowballSector(undefined, 'STOCK')).toBeUndefined();
    expect(snowballSector(' ', undefined)).toBeUndefined();
    expect(snowballSector('Luxury Goods', 'STOCK')).toBe('Luxury Goods');
  });

  it('maps country aliases and keeps the rest as written', () => {
    expect(snowballCountry('United States of America')).toBe('United States');
    expect(snowballCountry('UK')).toBe('United Kingdom');
    expect(snowballCountry('Taiwan')).toBe('Taiwan');
    expect(snowballCountry('Other')).toBe('Other');
    expect(snowballCountry('')).toBeUndefined();
    expect(snowballCountry(undefined)).toBeUndefined();
    expect(Object.keys(SNOWBALL_COUNTRIES)).toContain('united states of america');
  });
});
