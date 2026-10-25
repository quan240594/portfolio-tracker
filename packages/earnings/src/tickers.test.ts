import { describe, expect, it } from 'vitest';
import { TICKER_ALIASES, lookupTicker, resolveTicker, significantWords, type TickerTable } from './tickers.js';

const table: TickerTable = new Map([
  ['AAPL', { cik: '320193', title: 'Apple Inc.' }],
  ['BRK-B', { cik: '1067983', title: 'BERKSHIRE HATHAWAY INC' }],
  ['ASML', { cik: '937966', title: 'ASML HOLDING NV' }],
  ['NVO', { cik: '353278', title: 'NOVO NORDISK A S' }],
  ['TSM', { cik: '1046179', title: 'TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD' }],
  ['CRM', { cik: '1108524', title: 'SALESFORCE, INC.' }],
  ['MA', { cik: '1141391', title: 'Mastercard Inc' }],
  ['NFLX', { cik: '1065280', title: 'NETFLIX INC' }],
  ['ADBE', { cik: '796343', title: 'ADOBE INC.' }],
  ['UNH', { cik: '731766', title: 'UNITEDHEALTH GROUP INC' }],
  ['SHEL', { cik: '1306965', title: 'Shell plc' }],
  ['SMID', { cik: '1', title: 'Shell Midstream Partners' }],
  ['VZ', { cik: '732712', title: 'Verizon Communications Inc.' }],
  ['DUP1', { cik: '9', title: 'Dupe Corp' }],
  ['DUP2', { cik: '10', title: 'Dupe Inc' }],
  ['GOOGL', { cik: '1652044', title: 'Alphabet Inc.' }],
  ['GOOG', { cik: '1652044', title: 'Alphabet Inc.' }],
]);

describe('resolveTicker', () => {
  it('a US ticker is itself; a class share is a dash in the SEC table', () => {
    expect(resolveTicker(table, { symbol: 'AAPL' })).toEqual({ cik: '320193', via: 'ticker' });
    expect(resolveTicker(table, { symbol: 'BRK.B', name: 'Berkshire Hathaway' })).toEqual({ cik: '1067983', via: 'ticker' });
    expect(resolveTicker(table, { symbol: 'brk-b' })).toEqual({ cik: '1067983', via: 'ticker' });
  });

  it('a suffixed listing matches its US ticker only when the names agree', () => {
    expect(resolveTicker(table, { symbol: 'ASML.AS', name: 'ASML Holding' })).toEqual({ cik: '937966', via: 'ticker' });
    expect(resolveTicker(table, { symbol: 'AAPL.MI', name: 'Totally Different Company' })).toBeUndefined();
    expect(resolveTicker(table, { symbol: 'AAPL.MI' })).toBeUndefined();
  });

  it.each([
    ['FOO.DE', 'Salesforce', '1108524'],
    ['M4I.DE', 'Mastercard', '1141391'],
    ['NFC.DE', 'Netflix', '1065280'],
    ['ADB.DE', 'Adobe', '796343'],
  ])('%s is %s through the alias table (checked against the name)', (symbol, name, cik) => {
    expect(resolveTicker(table, { symbol, name })).toEqual({ cik, via: 'alias' });
    expect(resolveTicker(table, { symbol, name: 'Something Else Entirely' })).toBeUndefined();
    expect(TICKER_ALIASES.get(symbol.split('.')[0]!)).toBeDefined();
  });

  it('falls back to the company name: foreign issuers listed elsewhere, and a renamed US ticker', () => {
    expect(resolveTicker(table, { symbol: 'NOVO-B.CO', name: 'Novo Nordisk A/S', isin: 'DK0062498333' })).toEqual({ cik: '353278', via: 'name' });
    expect(resolveTicker(table, { symbol: 'TSMC.TW', name: 'Taiwan Semiconductor Manufacturing Company Limited' })).toEqual({ cik: '1046179', via: 'name' });
    expect(resolveTicker(table, { symbol: 'OLDTICK', name: 'Netflix, Inc.' })).toEqual({ cik: '1065280', via: 'name' });
  });

  it('a US ISIN allows the start of the title (UnitedHealth), a foreign one needs the same words; an ambiguous name matches nothing', () => {
    expect(resolveTicker(table, { symbol: 'VOW.DE', name: 'Verizon', isin: 'US92343V1044' })).toEqual({ cik: '732712', via: 'name' });
    expect(resolveTicker(table, { symbol: 'VOW.DE', name: 'Verizon', isin: 'DE0000000000' })).toBeUndefined();
    expect(resolveTicker(table, { symbol: 'XDUP.DE', name: 'Dupe' })).toBeUndefined();
    expect(resolveTicker(table, { symbol: 'RDSA.L', name: 'Shell', isin: 'GB00BP6MXD84' })).toEqual({ cik: '1306965', via: 'name' });
    expect(resolveTicker(table, { symbol: 'ALPH.DE', name: 'Alphabet' })).toEqual({ cik: '1652044', via: 'name' });
  });

  it('an unknown symbol, a symbol named after itself and an empty name match nothing', () => {
    expect(resolveTicker(table, { symbol: 'NOPE' })).toBeUndefined();
    expect(resolveTicker(table, { symbol: 'NOPE.AS', name: 'NOPE.AS' })).toBeUndefined();
    expect(resolveTicker(table, { symbol: 'NOPE.AS', name: '  ' })).toBeUndefined();
    expect(significantWords('The Coca-Cola Company, Inc.')).toEqual(['coca', 'cola']);
  });

  it('lookupTicker is the CIK only', () => {
    expect(lookupTicker(table, 'AAPL', undefined)).toBe('320193');
    expect(lookupTicker(table, 'BP.L', 'British Petroleum Group')).toBeUndefined();
  });
});
