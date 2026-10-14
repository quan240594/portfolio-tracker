import { describe, expect, it } from 'vitest';
import {
  BROKER_STATE_PREFIX,
  brokerKeys,
  brokerScopeSchema,
  brokerSyncEventSchema,
  classifyAction,
  connectBrokerSchema,
  convertTrading212Csv,
  exchangeSuffix,
  isTrading212Header,
  mapT212Symbol,
  normalizeCurrency,
  parseCsvText,
  resolveFxRate,
  roundTo,
  t212SecretName,
  toBrokerStatus,
  trading212CredentialsSchema,
  csvRowSchema,
  type BrokerSyncState,
} from './index.js';

describe('currency helpers', () => {
  it('normalizes minor units and codes', () => {
    expect(normalizeCurrency('GBX')).toEqual({ currency: 'GBP', divisor: 100 });
    expect(normalizeCurrency('GBp')).toEqual({ currency: 'GBP', divisor: 100 });
    expect(normalizeCurrency('zac')).toEqual({ currency: 'ZAR', divisor: 100 });
    expect(normalizeCurrency(' usd ')).toEqual({ currency: 'USD', divisor: 1 });
  });

  it('rounds', () => {
    expect(roundTo(1.0000005, 6)).toBe(1.000001);
  });

  describe('resolveFxRate', () => {
    // 370 USD paid with 338 EUR -> implied 1.0947 USD per EUR
    const base = { accountAmount: 338, localAmount: 370 };
    it('accepts a reported rate that matches the implied direction', () => {
      expect(resolveFxRate({ ...base, reported: 1.095 })).toBe(1.095);
    });
    it('inverts a reported rate in the opposite direction', () => {
      expect(resolveFxRate({ ...base, reported: 0.9132 })).toBe(roundTo(1 / 0.9132, 6));
    });
    it('rejects values inconsistent with the amounts', () => {
      expect(resolveFxRate({ ...base, reported: 1.4 })).toBeUndefined();
      expect(resolveFxRate({ ...base, reported: 0.5 })).toBeUndefined();
    });
    it('needs usable inputs', () => {
      expect(resolveFxRate({ ...base, reported: undefined })).toBeUndefined();
      expect(resolveFxRate({ ...base, reported: Number.NaN })).toBeUndefined();
      expect(resolveFxRate({ ...base, reported: -1 })).toBeUndefined();
      expect(resolveFxRate({ localAmount: 370, accountAmount: undefined, reported: 1.09 })).toBeUndefined();
      expect(resolveFxRate({ localAmount: 370, accountAmount: 0, reported: 1.09 })).toBeUndefined();
      expect(resolveFxRate({ localAmount: 0, accountAmount: 10, reported: 1.09 })).toBeUndefined();
    });
  });
});

describe('mapT212Symbol', () => {
  const map = (ticker: string, currency: string, extra: { isin?: string; exchange?: string } = {}, overrides = {}) =>
    mapT212Symbol({ ticker, currency, ...extra }, overrides);

  it('maps country-coded tickers', () => {
    expect(map('AAPL_US_EQ', 'USD')).toEqual({ ok: true, symbol: 'AAPL', via: 'ticker' });
    expect(map('ASML_NL_EQ', 'EUR')).toEqual({ ok: true, symbol: 'ASML.AS', via: 'ticker' });
    expect(map('ASML_NA_EQ', 'EUR')).toEqual({ ok: true, symbol: 'ASML.AS', via: 'ticker' });
    expect(map('BRK.B_US_EQ', 'USD')).toEqual({ ok: true, symbol: 'BRK-B', via: 'ticker' });
    expect(map('BRK/A_US_EQ', 'USD')).toEqual({ ok: true, symbol: 'BRK-A', via: 'ticker' });
    expect(map('XX_ZZ_EQ', 'USD')).toEqual({ ok: false, reason: 'NO_PATTERN' });
  });

  it('maps renamed listings to the current symbol unless overridden', () => {
    expect(map('FB_US_EQ', 'USD')).toEqual({ ok: true, symbol: 'META', via: 'ticker' });
    expect(map('DAId_EQ', 'EUR')).toEqual({ ok: true, symbol: 'MBG.DE', via: 'ticker' });
    expect(map('FB_US_EQ', 'USD', {}, { FB_US_EQ: 'FB' })).toEqual({ ok: true, symbol: 'FB', via: 'override' });
  });

  it('maps venue-letter tickers', () => {
    expect(map('ASMLa_EQ', 'EUR')).toEqual({ ok: true, symbol: 'ASML.AS', via: 'ticker' });
    expect(map('SAPd_EQ', 'EUR')).toEqual({ ok: true, symbol: 'SAP.DE', via: 'ticker' });
    expect(map('VUSAl_EQ', 'GBX')).toEqual({ ok: true, symbol: 'VUSA.L', via: 'ticker' });
    expect(map('VUSAl_EQ', 'GBp')).toMatchObject({ ok: true });
    expect(map('VWCEx_EQ', 'EUR')).toEqual({ ok: false, reason: 'NO_PATTERN' });
    expect(map('VWCEx_EQ', 'EUR', { exchange: 'Xetra' })).toEqual({ ok: true, symbol: 'VWCE.DE', via: 'exchange' });
  });

  it('uses exchange metadata, then the ISIN country, for bare tickers', () => {
    expect(map('SAP_EQ', 'EUR', { exchange: 'XETRA' })).toEqual({ ok: true, symbol: 'SAP.DE', via: 'exchange' });
    expect(map('SAP', 'EUR', { isin: 'DE0007164600' })).toEqual({ ok: true, symbol: 'SAP.DE', via: 'isin' });
    expect(map('AAPL', 'USD', { isin: 'US0378331005' })).toEqual({ ok: true, symbol: 'AAPL', via: 'isin' });
    expect(map('SAP_EQ', 'EUR', { exchange: 'Unknown Venue', isin: 'DE0007164600' })).toMatchObject({ via: 'isin' });
  });

  it('never guesses ambiguous listings', () => {
    expect(map('VWRL', 'EUR', { isin: 'IE00B3RBWM25' })).toEqual({ ok: false, reason: 'AMBIGUOUS_LISTING' });
    expect(map('VWRL', 'EUR')).toEqual({ ok: false, reason: 'AMBIGUOUS_LISTING' });
    expect(map('???', 'EUR')).toEqual({ ok: false, reason: 'NO_PATTERN' });
    expect(map('AAPL_US_X', 'USD')).toEqual({ ok: false, reason: 'NO_PATTERN' });
  });

  it('rejects currencies that do not fit the venue', () => {
    expect(map('AAPL_US_EQ', 'EUR')).toEqual({ ok: false, reason: 'CURRENCY_MISMATCH' });
    expect(map('SAPd_EQ', 'USD')).toEqual({ ok: false, reason: 'CURRENCY_MISMATCH' });
  });

  it('rejects symbols that do not satisfy the symbol schema', () => {
    expect(map('A'.repeat(25) + '_US_EQ', 'USD')).toEqual({ ok: false, reason: 'INVALID_SYMBOL' });
  });

  it('applies overrides by ticker or ISIN before anything else', () => {
    expect(map('VWRL', 'EUR', { isin: 'IE00B3RBWM25' }, { IE00B3RBWM25: 'vwrl.as' })).toEqual({ ok: true, symbol: 'VWRL.AS', via: 'override' });
    expect(map('ASMLa_EQ', 'EUR', {}, { ASMLa_EQ: 'ASML.AS' })).toMatchObject({ via: 'override' });
    expect(map('ASMLa_EQ', 'EUR', {}, { ASMLa_EQ: 'bad symbol' })).toEqual({ ok: false, reason: 'INVALID_SYMBOL' });
  });

  it('recognises exchange names', () => {
    expect(exchangeSuffix('NASDAQ')).toBe('');
    expect(exchangeSuffix('London Stock Exchange')).toBe('.L');
    expect(exchangeSuffix('Euronext Amsterdam')).toBe('.AS');
    expect(exchangeSuffix('Deutsche Börse Xetra')).toBe('.DE');
    expect(exchangeSuffix('Narnia Exchange')).toBeUndefined();
  });
});

describe('parseCsvText', () => {
  it('handles quotes, escaped quotes, CRLF, BOM, blank lines and a missing final newline', () => {
    const text = '\ufeffa,b,c\r\n1,"x, ""y""",3\r\n\r\n4,5,6';
    expect(parseCsvText(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, "y"', '3'],
      ['4', '5', '6'],
    ]);
  });
  it('returns nothing for empty input', () => {
    expect(parseCsvText('')).toEqual([]);
  });
});

const HEADER =
  'Action,Time,ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Total,Currency (Total),Withholding tax,Currency (Withholding tax),Stamp duty reserve tax,Currency (Stamp duty reserve tax),Currency conversion fee,Currency (Currency conversion fee)';
const csvOf = (...lines: string[]) => [HEADER, ...lines].join('\n');

describe('Trading 212 CSV', () => {
  it('detects the header', () => {
    expect(isTrading212Header(HEADER.split(','))).toBe(true);
    expect(isTrading212Header(['date', 'type', 'symbol'])).toBe(false);
    // Current exports label the time column `Time (UTC)`.
    expect(isTrading212Header(HEADER.replace('Time', 'Time (UTC)').split(','))).toBe(true);
    expect(isTrading212Header(HEADER.replace('Time,', '').split(','))).toBe(false);
  });

  it('classifies actions', () => {
    expect(classifyAction('Market buy')).toBe('BUY');
    expect(classifyAction('Limit sell')).toBe('SELL');
    expect(classifyAction('Stop limit buy')).toBe('BUY');
    expect(classifyAction('Dividend (Ordinary)')).toBe('DIVIDEND');
    expect(classifyAction('Deposit')).toBeUndefined();
  });

  const sample = csvOf(
    'Deposit,2024-01-02 09:00:00,,,,Bank transfer,D1,,,,,,,1000.00,EUR,,,,,,',
    'Market sell,2024-02-01 10:00:00,US0378331005,AAPL,Apple,,O3,1,190.00,USD,1.10,12.00,EUR,172.50,EUR,,,,,0.26,EUR',
    'Market buy,2024-01-03 15:31:02,US0378331005,AAPL,Apple,,O1,2,185.00,USD,1.0950,,,338.41,EUR,,,,,0.51,EUR',
    'Limit buy,2024-01-04 08:01:00,NL0010273215,ASML,"ASML ""Holding"", NV",,O2,1.5,100.00,EUR,,,,150,EUR,,,,,,',
    'Market buy,2024-01-05 08:01:00,GB00B03MLX29,RDSA,Shell,,O4,10,2500,GBX,0.86,,,290.70,EUR,,,5.00,GBP,,',
    'Dividend (Ordinary),2024-03-01 00:00:00,US0378331005,AAPL,Apple,,DV1,2,0.24,USD,Not available,,,0.37,EUR,0.07,USD,,,,',
    'Dividend (Ordinary),2024-03-02 00:00:00,NL0010273215,ASML,ASML Holding,,DV2,1.5,1.00,EUR,,,,1.2,EUR,0.3,EUR,,,,',
    'Market buy,2024-03-03 00:00:00,IE00B3RBWM25,VWRL,Vanguard,,O5,1,100,EUR,,,,100,EUR,,,,,,',
    'Market buy,2024-03-03 01:00:00,IE00B3RBWM25,VWRL,Vanguard,,O7,1,100,EUR,,,,100,EUR,,,,,,',
    'Market buy,2024-03-04 00:00:00,US0000000000,,NoTicker,,O6,1,100,USD,,,,100,USD,,,,,,',
    'Market buy,2024-03-04 00:00:00,US0378331005,AAPL,Apple,,O8,abc,100,USD,,,,100,USD,,,,,,',
    'Interest on cash,2024-03-05 00:00:00,,,,,I1,,,,,,,0.5,EUR,,,,,,',
    ',2024-03-05 00:00:00,,,,,I2,,,,,,,0.5,EUR,,,,,,',
    'Deposit,2024-03-06 00:00:00,,,,,D2,,,,,,,5,EUR,,,,,,',
  );

  it('converts the current export layout (Time (UTC), Dividend (Dividend), card actions ignored)', () => {
    const csv = [
      'Action,Time (UTC),ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Total,Currency (Total),Withholding tax,Currency (Withholding tax),Currency conversion fee,Currency (Currency conversion fee)',
      'Market buy,2026-01-05 10:00:00.123,US0378331005,AAPL,Apple,,EOF1,2,100,USD,1.1,181.99,EUR,,,0.27,EUR',
      'Dividend (Dividend),2026-01-06 00:00:00,US0378331005,AAPL,Apple,,EOF2,2,0.25,USD,1.1,0.39,EUR,0.07,EUR,,',
      'Card debit,2026-01-07 09:00:00,,,,,EOF3,,,,,5,EUR,,,,',
      'Spending cashback,2026-01-08 09:00:00,,,,,EOF4,,,,,0.1,EUR,,,,',
    ].join('\n');
    const res = convertTrading212Csv(csv);
    expect(res.csv.trim().split('\n')[1]).toMatch(/^2026-01-05,BUY,AAPL,2,100,0\.297,USD,T212 AAPL,1\.1\d*$/);
    expect(res.imported).toBe(2);
    expect(res.ignored).toEqual([
      { action: 'Card debit', count: 1 },
      { action: 'Spending cashback', count: 1 },
    ]);
  });

  it('converts trades and dividends in time order, with fx rate and fees in the instrument currency', () => {
    const res = convertTrading212Csv(sample);
    expect(res.csv.trim().split('\n')).toEqual([
      'date,type,symbol,quantity,price,fee,currency,note,fxRate',
      '2024-01-03,BUY,AAPL,2,185,0.55845,USD,T212 AAPL,1.095',
      '2024-01-04,BUY,ASML.AS,1.5,100,0,EUR,T212 ASML,',
      '2024-01-05,BUY,RDSA.L,10,25,5,GBP,T212 RDSA,0.86',
      '2024-02-01,SELL,AAPL,1,190,0.286,USD,T212 AAPL,1.1',
      '2024-03-01,DIVIDEND,AAPL,2,0.24,0.07,USD,T212 AAPL,1.108108',
      '2024-03-02,DIVIDEND,ASML.AS,1.5,1,0.3,EUR,T212 ASML,',
    ]);
    expect(res.imported).toBe(6);
    expect(res.warnings).toEqual([]);
  });

  it('reports ignored actions, unmapped instruments and invalid rows', () => {
    const res = convertTrading212Csv(sample);
    expect(res.ignored).toEqual([
      { action: '(blank)', count: 1 },
      { action: 'Deposit', count: 2 },
      { action: 'Interest on cash', count: 1 },
    ]);
    expect(res.unmapped).toEqual([
      { ticker: 'VWRL', isin: 'IE00B3RBWM25', name: 'Vanguard', currency: 'EUR', reason: 'AMBIGUOUS_LISTING', count: 2 },
    ]);
    expect(res.invalid.map((i) => i.row)).toEqual([10, 11]);
  });

  it('applies overrides and produces rows the import validator accepts', () => {
    const res = convertTrading212Csv(sample, { IE00B3RBWM25: 'VWRL.AS' });
    expect(res.unmapped).toEqual([]);
    expect(res.csv).toContain('VWRL.AS');
    const [head, ...rows] = parseCsvText(res.csv);
    for (const r of rows) {
      const parsed = csvRowSchema.safeParse(Object.fromEntries(head!.map((h, i) => [h, r[i]])));
      expect(parsed.success).toBe(true);
    }
  });

  it('omits fxRate for non-EUR accounts or when the rate contradicts the amounts', () => {
    const gbpAccount = csvOf('Market buy,2024-01-03 15:31:02,US0378331005,AAPL,Apple,,O1,2,185.00,USD,1.27,,,291.34,GBP,,,,,,');
    expect(convertTrading212Csv(gbpAccount).csv).toContain('2024-01-03,BUY,AAPL,2,185,0,USD,T212 AAPL,\n');
    const bad = csvOf('Market buy,2024-01-03 15:31:02,US0378331005,AAPL,Apple,,O1,2,185.00,USD,3.0,,,338.41,EUR,,,,,,');
    expect(convertTrading212Csv(bad).csv).toContain(',T212 AAPL,\n');
  });

  it('warns about fees it cannot convert', () => {
    const odd = csvOf('Market buy,2024-01-03 15:31:02,US0378331005,AAPL,Apple,,O1,2,185.00,USD,,,,338.41,EUR,,,,,0.5,EUR');
    const res = convertTrading212Csv(odd);
    expect(res.warnings).toEqual(['1 fee amount(s) in another currency could not be converted and were left out']);
  });

  it('handles an empty or unrecognised file', () => {
    expect(convertTrading212Csv('')).toMatchObject({ imported: 0, ignored: [], invalid: [] });
  });
});

describe('contract', () => {
  it('builds keys and secret names', () => {
    expect(brokerKeys.state('u1', 'p1')).toEqual({ PK: 'USER#u1', SK: 'BROKER#trading212#p1' });
    expect(brokerKeys.statePrefix).toBe(BROKER_STATE_PREFIX);
    expect(t212SecretName('/portfolio-tracker/dev/broker/trading212/', 'u-1')).toBe('/portfolio-tracker/dev/broker/trading212/u-1');
    expect(() => t212SecretName('/x', 'a/b')).toThrow();
  });

  it('validates requests', () => {
    expect(connectBrokerSchema.parse({ portfolioId: 'p', apiKey: ' k ', apiSecret: 's' })).toEqual({
      portfolioId: 'p',
      apiKey: 'k',
      apiSecret: 's',
      environment: 'live',
    });
    expect(connectBrokerSchema.safeParse({ portfolioId: 'p', apiKey: '', apiSecret: 's' }).success).toBe(false);
    expect(connectBrokerSchema.safeParse({ portfolioId: 'all', apiKey: 'k', apiSecret: 's' }).success).toBe(false);
    expect(trading212CredentialsSchema.safeParse({ apiKey: 'k', apiSecret: 's', environment: 'paper' }).success).toBe(false);
    expect(brokerScopeSchema.safeParse({}).success).toBe(false);
    expect(brokerSyncEventSchema.parse({ all: true })).toEqual({ all: true });
    expect(brokerSyncEventSchema.parse({ userId: 'u', portfolioId: 'p', full: true })).toEqual({ userId: 'u', portfolioId: 'p', full: true });
    expect(brokerSyncEventSchema.safeParse({ userId: 'u' }).success).toBe(false);
  });

  it('exposes a status without internals or credentials', () => {
    expect(toBrokerStatus('p', null)).toEqual({ broker: 'trading212', portfolioId: 'p', connected: false });
    const state: BrokerSyncState = {
      userId: 'u',
      portfolioId: 'p',
      broker: 'trading212',
      environment: 'live',
      status: 'SUCCEEDED',
      connectedAt: 'c',
      updatedAt: 'u',
      runStartedAt: 'r',
      cursors: { orders: 'x' },
      lastSyncAt: 's',
    };
    expect(toBrokerStatus('p', state)).toEqual({
      broker: 'trading212',
      portfolioId: 'p',
      connected: true,
      environment: 'live',
      status: 'SUCCEEDED',
      connectedAt: 'c',
      lastSyncAt: 's',
    });
  });
});
