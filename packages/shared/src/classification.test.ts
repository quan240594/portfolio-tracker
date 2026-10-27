import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_ROUTES,
  applyClassificationOverrides,
  baseTicker,
  classificationFieldsOf,
  classificationImportSchema,
  classificationKeys,
  classificationPutSchema,
  classificationValues,
  hasClassification,
  HISTORY_SYMBOL_MESSAGE,
  isProfileSource,
  matchClassificationRows,
  mergeProfile,
  sourceOf,
  type ClassificationRow,
  type ClassificationTarget,
} from './classification.js';
import { assetClassFromTrading212Type, isinCountry, trading212Profile } from './instrument-baseline.js';
import type { InstrumentProfile } from './types.js';

const minimal = (symbol: string): InstrumentProfile => ({ symbol, name: symbol, assetClass: 'OTHER', currency: 'EUR', profileSource: 'minimal' });
const baseline: InstrumentProfile = { symbol: 'FUND.MI', name: 'Invented World Fund', assetClass: 'ETF', currency: 'EUR', isin: 'IE00INVENT01', country: 'Ireland', profileSource: 'trading212' };
const provider: InstrumentProfile = { symbol: 'FUND.MI', name: 'Invented World Fund UCITS', assetClass: 'ETF', currency: 'EUR', sector: 'Diversified', country: 'Italy', exchange: 'Borsa Italiana', profileSource: 'provider', detailsAsOf: '2026-10-01' };

describe('contract', () => {
  it('lists the routes and keys', () => {
    expect(Object.values(CLASSIFICATION_ROUTES)).toEqual(['GET /classification', 'POST /classification/import', 'PUT /classification/{symbol}', 'DELETE /classification/{symbol}']);
    expect(classificationKeys.override('u1', 'FWRA.MI')).toEqual({ PK: 'USER#u1', SK: 'CLASS#FWRA.MI' });
    expect(classificationKeys.prefix).toBe('CLASS#');
  });

  it('validates a put body', () => {
    expect(classificationPutSchema.safeParse({ sector: ' Energy ' })).toMatchObject({ success: true, data: { sector: 'Energy' } });
    expect(classificationPutSchema.safeParse({}).success).toBe(false);
    expect(classificationPutSchema.safeParse({ assetClass: 'WIDGET' }).success).toBe(false);
    expect(classificationPutSchema.safeParse({ name: '' }).success).toBe(false);
    expect(classificationPutSchema.safeParse({ name: 'x', extra: 1 }).success).toBe(false);
  });

  it('accepts the website domain alone, normalised, and refuses one that is not a public host', () => {
    expect(classificationPutSchema.safeParse({ domain: ' https://www.Apple.com/mac ' })).toMatchObject({ success: true, data: { domain: 'apple.com' } });
    expect(classificationPutSchema.safeParse({ name: 'x', domain: 'sap.com' })).toMatchObject({ success: true, data: { name: 'x', domain: 'sap.com' } });
    expect(classificationPutSchema.safeParse({ domain: 'localhost' }).success).toBe(false);
    expect(classificationPutSchema.safeParse({ domain: '10.0.0.1' }).success).toBe(false);
    expect(classificationPutSchema.safeParse({ domain: '' }).success).toBe(false);
    // An import row never carries a domain.
    expect(classificationImportSchema.safeParse({ rows: [{ ticker: 'A', domain: 'apple.com' }] }).success).toBe(false);
  });

  it('accepts a price history symbol, trimmed and upper-cased, alone or with other fields', () => {
    expect(classificationPutSchema.safeParse({ historySymbol: ' fwra.de ' })).toMatchObject({ success: true, data: { historySymbol: 'FWRA.DE' } });
    expect(classificationPutSchema.safeParse({ sector: 'x', historySymbol: 'BRK-B' })).toMatchObject({ success: true, data: { sector: 'x', historySymbol: 'BRK-B' } });
    expect(classificationPutSchema.safeParse({ historySymbol: 'A'.repeat(20) }).success).toBe(true);
    expect(classificationPutSchema.safeParse({ historySymbol: '9988.HK' }).success).toBe(true);
  });

  it.each(['FWRA/DE', 'FWRA DE', 'FWRA%2EDE', '.DE', '-X', 'A'.repeat(21), 'FWRÄ.DE', 'FWRA\nDE'])('refuses the price history symbol %j', (historySymbol) => {
    const parsed = classificationPutSchema.safeParse({ sector: 'x', historySymbol });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({ path: ['historySymbol'], message: HISTORY_SYMBOL_MESSAGE });
  });

  it('refuses a price history symbol that is not text', () => {
    expect(classificationPutSchema.safeParse({ sector: 'x', historySymbol: 5 }).success).toBe(false);
  });

  it('clears the price history symbol with null or an empty text, leaving it out of the result', () => {
    expect(classificationPutSchema.safeParse({ sector: 'x', historySymbol: null })).toMatchObject({ success: true, data: { sector: 'x' } });
    expect(classificationPutSchema.safeParse({ sector: 'x', historySymbol: '  ' })).toEqual({ success: true, data: { sector: 'x' } });
    // Only a clear is a valid body (the route then removes the override that has nothing left); an empty body is not.
    expect(classificationPutSchema.safeParse({ historySymbol: null })).toEqual({ success: true, data: {} });
    expect(classificationPutSchema.safeParse({ historySymbol: '' })).toEqual({ success: true, data: {} });
    expect(classificationPutSchema.safeParse({}).success).toBe(false);
  });

  it('counts the price history symbol as a classification field', () => {
    expect(hasClassification({ historySymbol: 'FWRA.DE' })).toBe(true);
    expect(classificationFieldsOf({ historySymbol: 'FWRA.DE', ...{ userId: 'u' } })).toEqual({ historySymbol: 'FWRA.DE' });
  });

  it('validates an import body and normalises tickers, ISINs and currencies', () => {
    const parsed = classificationImportSchema.parse({ rows: [{ ticker: ' fwra ', isin: ' ie00invent01', currency: 'eur', assetClass: 'ETF' }] });
    expect(parsed).toEqual({ dryRun: false, rows: [{ ticker: 'FWRA', isin: 'IE00INVENT01', currency: 'EUR', assetClass: 'ETF' }] });
    expect(classificationImportSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(classificationImportSchema.safeParse({ rows: [{ ticker: 'A', isin: 'bad' }] }).success).toBe(false);
    expect(classificationImportSchema.safeParse({ rows: Array.from({ length: 1001 }, () => ({ ticker: 'A', sector: 'x' })) }).success).toBe(false);
  });

  it('keeps only the fields that are set', () => {
    expect(classificationFieldsOf({ name: 'N', sector: undefined, country: 'C', assetClass: 'ETF', ...{ userId: 'u' } })).toEqual({ name: 'N', country: 'C', assetClass: 'ETF' });
    expect(hasClassification({})).toBe(false);
    expect(hasClassification({ sector: 'x' })).toBe(true);
    expect(hasClassification({ domain: 'apple.com' })).toBe(true);
    expect(classificationFieldsOf({ domain: 'apple.com', ...{ userId: 'u' } })).toEqual({ domain: 'apple.com' });
  });
});

describe('mergeProfile', () => {
  it('returns the incoming profile when there is none yet', () => {
    expect(mergeProfile(undefined, baseline)).toBe(baseline);
  });

  it('lets a provider profile override the baseline field by field, never the reverse', () => {
    const up = mergeProfile(baseline, provider);
    expect(up).toMatchObject({ name: 'Invented World Fund UCITS', sector: 'Diversified', country: 'Italy', isin: 'IE00INVENT01', profileSource: 'provider', detailsAsOf: '2026-10-01' });
    const down = mergeProfile(provider, baseline);
    expect(down).toMatchObject({ name: 'Invented World Fund UCITS', sector: 'Diversified', country: 'Italy', isin: 'IE00INVENT01', profileSource: 'provider' });
  });

  it('never replaces a real value with a placeholder', () => {
    const placeholder: InstrumentProfile = { symbol: 'FUND.MI', name: 'FUND.MI', assetClass: 'OTHER', currency: 'EUR', profileSource: 'provider' };
    expect(mergeProfile(baseline, placeholder)).toMatchObject({ name: 'Invented World Fund', assetClass: 'ETF', profileSource: 'provider' });
    expect(mergeProfile(minimal('FUND.MI'), baseline)).toMatchObject({ name: 'Invented World Fund', assetClass: 'ETF', profileSource: 'trading212' });
    expect(mergeProfile(baseline, minimal('FUND.MI'))).toMatchObject({ name: 'Invented World Fund', assetClass: 'ETF', profileSource: 'trading212' });
  });

  it('keeps a placeholder when nothing better exists and treats a legacy profile as a provider profile', () => {
    expect(mergeProfile(minimal('X'), minimal('X'))).toEqual(minimal('X'));
    const { profileSource: _legacy, ...legacy } = provider;
    expect(sourceOf(legacy)).toBe('provider');
    expect(mergeProfile(legacy, baseline)).toMatchObject({ name: 'Invented World Fund UCITS', profileSource: 'provider', country: 'Italy' });
    expect(isProfileSource('trading212')).toBe(true);
    expect(isProfileSource('other')).toBe(false);
  });

  it('keeps the Trading 212 ticker whichever profile wins, and never stores an invalid one', () => {
    const withTicker: InstrumentProfile = { ...baseline, t212Ticker: 'FUNDm_EQ' };
    expect(mergeProfile(withTicker, provider).t212Ticker).toBe('FUNDm_EQ');
    expect(mergeProfile(provider, withTicker).t212Ticker).toBe('FUNDm_EQ');
    expect(mergeProfile(withTicker, { ...provider, t212Ticker: undefined }).t212Ticker).toBe('FUNDm_EQ');
    expect(mergeProfile(withTicker, { ...provider, t212Ticker: 'NEWm_EQ' }).t212Ticker).toBe('NEWm_EQ');
    expect(mergeProfile(withTicker, { ...provider, t212Ticker: 'a/b' }).t212Ticker).toBe('FUNDm_EQ');
    expect(mergeProfile({ ...provider, t212Ticker: '..' }, provider)).not.toHaveProperty('t212Ticker');
  });

  it('drops a field no side has', () => {
    const merged = mergeProfile({ ...baseline, sector: undefined }, { ...baseline, name: 'FUND.MI', sector: undefined });
    expect(merged).not.toHaveProperty('sector');
    expect(merged.name).toBe('Invented World Fund');
  });
});

describe('applyClassificationOverrides', () => {
  const profiles = { 'FUND.MI': provider, 'AAA': { symbol: 'AAA', name: 'Aaa Inc', assetClass: 'STOCK', currency: 'USD', sector: 'Technology', country: 'United States' } as InstrumentProfile };

  it('lets an override win field by field and leaves the rest of the profile alone', () => {
    const out = applyClassificationOverrides(profiles, { 'FUND.MI': { name: 'My fund', assetClass: 'COMMODITY' }, ZZZ: { name: 'Nothing known' } });
    expect(out['FUND.MI']).toEqual({ ...provider, name: 'My fund', assetClass: 'COMMODITY' });
    expect(out.AAA).toBe(profiles.AAA);
    expect(out).not.toHaveProperty('ZZZ');
    expect(profiles['FUND.MI'].name).toBe('Invented World Fund UCITS');
  });

  it('does not lay the logo domain over the profile, and a domain-only override creates no profile', () => {
    const out = applyClassificationOverrides(profiles, { AAA: { domain: 'aaa.example.com', sector: 'Energy' }, BBB: { domain: 'bbb.example.com' } }, { BBB: 'EUR' });
    expect(out.AAA).toEqual({ ...profiles.AAA, sector: 'Energy' });
    expect(out).not.toHaveProperty('BBB');
  });

  it('builds a profile from the override when the currency is known', () => {
    const out = applyClassificationOverrides({}, { ZZZ: { name: 'Mine', sector: 'Energy' }, YYY: { country: 'Peru' } }, { ZZZ: 'EUR' });
    expect(out.ZZZ).toEqual({ symbol: 'ZZZ', name: 'Mine', assetClass: 'OTHER', currency: 'EUR', sector: 'Energy' });
    expect(out).not.toHaveProperty('YYY');
    expect(applyClassificationOverrides({}, { ZZZ: { assetClass: 'ETF' } }, { ZZZ: 'EUR' }).ZZZ).toMatchObject({ name: 'ZZZ', assetClass: 'ETF' });
  });

  it('describes the values of a profile', () => {
    expect(classificationValues(provider, 'FUND.MI')).toEqual({ name: 'Invented World Fund UCITS', assetClass: 'ETF', sector: 'Diversified', country: 'Italy' });
    expect(classificationValues(undefined, 'ZZZ')).toEqual({ name: 'ZZZ', assetClass: 'OTHER', sector: null, country: null });
  });
});

describe('matchClassificationRows', () => {
  const target = (symbol: string, isin: string | undefined, currency: string, sector: string | null = null): ClassificationTarget => ({
    symbol,
    ...(isin === undefined ? {} : { isin }),
    currency,
    current: { name: symbol, assetClass: 'OTHER', sector, country: null },
  });
  const targets = [
    target('FUND.MI', 'IE00INVENT01', 'EUR'),
    target('FUND.L', 'IE00INVENT01', 'GBP'),
    target('AAA', 'US0000000002', 'USD', 'Technology'),
    target('BBB.AS', undefined, 'EUR'),
    target('CCC', undefined, 'USD'),
    target('CCC.DE', undefined, 'EUR'),
    target('BRK-B', 'US0846707026', 'USD'),
  ];
  const row = (extra: Partial<ClassificationRow>): ClassificationRow => ({ ticker: 'AAA', sector: 'Technology', ...extra });

  it('matches by ISIN first and lists only the real changes', () => {
    const { matched, unmatched } = matchClassificationRows([row({ ticker: 'AAAX', isin: 'US0000000002', sector: 'Technology', country: 'United States', name: 'Aaa Inc' })], targets);
    expect(unmatched).toEqual([]);
    expect(matched).toEqual([
      {
        index: 0,
        ticker: 'AAAX',
        symbol: 'AAA',
        matchedBy: 'isin',
        fields: { name: 'Aaa Inc', sector: 'Technology', country: 'United States' },
        changes: [
          { field: 'name', from: 'AAA', to: 'Aaa Inc' },
          { field: 'country', from: null, to: 'United States' },
        ],
      },
    ]);
  });

  it('picks the listing by ticker, then by currency, when an ISIN has several', () => {
    expect(matchClassificationRows([row({ ticker: 'FUND', isin: 'IE00INVENT01', currency: 'EUR' })], targets).matched[0]).toMatchObject({ symbol: 'FUND.MI', matchedBy: 'isin' });
    expect(matchClassificationRows([row({ ticker: 'OTHER', isin: 'IE00INVENT01', currency: 'GBP' })], targets).matched[0]).toMatchObject({ symbol: 'FUND.L' });
    expect(matchClassificationRows([row({ ticker: 'OTHER', isin: 'IE00INVENT01' })], targets).unmatched).toEqual([{ index: 0, ticker: 'OTHER', isin: 'IE00INVENT01', reason: 'ambiguous' }]);
  });

  it('falls back to the ticker without its exchange suffix', () => {
    const { matched } = matchClassificationRows([row({ ticker: 'bbb' }), row({ ticker: 'BRK.B', isin: 'US0846707026' }), row({ ticker: 'BRK.B' })], targets);
    expect(matched.map((m) => [m.ticker, m.symbol, m.matchedBy])).toEqual([['bbb', 'BBB.AS', 'ticker'], ['BRK.B', 'BRK-B', 'isin']]);
  });

  it('uses the currency to choose between listings of one ticker and reports what stays ambiguous', () => {
    expect(matchClassificationRows([row({ ticker: 'CCC', currency: 'EUR' })], targets).matched[0]).toMatchObject({ symbol: 'CCC.DE' });
    expect(matchClassificationRows([row({ ticker: 'CCC' })], targets).unmatched[0]).toMatchObject({ reason: 'ambiguous' });
    expect(baseTicker('ccc.de')).toBe('CCC');
    expect(baseTicker('BRK.B')).toBe('BRK-B');
  });

  it('never guesses: unknown tickers, contradicting ISINs, duplicates and empty rows are reported', () => {
    const { matched, unmatched } = matchClassificationRows(
      [row({ ticker: 'NOPE' }), row({ ticker: 'AAA', isin: 'US9999999990' }), row({ ticker: 'AAA' }), row({ ticker: 'AAA', sector: 'Energy' }), { ticker: 'BBB' }],
      targets,
    );
    expect(matched.map((m) => m.symbol)).toEqual(['AAA']);
    expect(unmatched.map((u) => [u.index, u.reason])).toEqual([[0, 'not-held'], [1, 'isin-mismatch'], [3, 'duplicate'], [4, 'empty']]);
    expect(unmatched[1]).toMatchObject({ isin: 'US9999999990' });
    expect(unmatched[0]).not.toHaveProperty('isin');
  });

  it('compares changes case-insensitively', () => {
    expect(matchClassificationRows([row({ sector: 'technology' })], targets).matched[0]!.changes).toEqual([]);
  });
});

describe('Trading 212 baseline profile', () => {
  it('maps type, ISIN, name and currency', () => {
    expect(trading212Profile('FUND.MI', { ticker: 'FUNDm_EQ', name: 'Invented World Fund', type: 'ETF', isin: 'ie00invent01', currency: 'EUR' }, 'EUR')).toEqual({
      symbol: 'FUND.MI',
      name: 'Invented World Fund',
      assetClass: 'ETF',
      currency: 'EUR',
      isin: 'IE00INVENT01',
      country: 'Ireland',
      t212Ticker: 'FUNDm_EQ',
      profileSource: 'trading212',
    });
    expect(trading212Profile('AAA', { ticker: 'AAA_US_EQ', shortName: 'AAA', type: 'STOCK' }, 'USD')).toEqual({ symbol: 'AAA', name: 'AAA', assetClass: 'STOCK', currency: 'USD', t212Ticker: 'AAA_US_EQ', profileSource: 'trading212' });
    expect(trading212Profile('AAA', { ticker: '../x', type: 'STOCK' }, 'USD')).not.toHaveProperty('t212Ticker');
    expect(trading212Profile('SMGB.L', { ticker: 'SMGBl_EQ', name: ' ', type: 'WARRANT', isin: 'JE00INVENT02', currency: 'GBX' }, 'GBP')).toMatchObject({ name: 'SMGB.L', assetClass: 'OTHER', currency: 'GBP', country: 'Jersey' });
  });

  it('maps the instrument types', () => {
    expect(assetClassFromTrading212Type('stock')).toBe('STOCK');
    expect(assetClassFromTrading212Type('CRYPTOCURRENCY')).toBe('CRYPTO');
    expect(assetClassFromTrading212Type('FUTURES')).toBe('OTHER');
    expect(assetClassFromTrading212Type(undefined)).toBe('OTHER');
  });

  it('derives the country from the ISIN prefix only for a valid ISIN with a known prefix', () => {
    expect(isinCountry('US0000000002')).toBe('United States');
    expect(isinCountry('XS0000000002')).toBeUndefined();
    expect(isinCountry('nope')).toBeUndefined();
    expect(isinCountry(undefined)).toBeUndefined();
  });
});
