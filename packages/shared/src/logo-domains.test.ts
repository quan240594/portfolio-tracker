import { describe, expect, it } from 'vitest';
import { SUFFIX_DOMAINS, US_DOMAINS } from './logo-domain-table.js';
import { ISSUER_DOMAINS, issuerDomain, normalizeDomain, resolveLogoDomain, splitLogoSymbol, tableDomain } from './logo-domains.js';

const DOMAIN_FORMAT = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const TICKER_FORMAT = /^[A-Z0-9]+(?:-[A-Z0-9]+)?$/;

const allTables = (): [string, Readonly<Record<string, string>>][] => [['US', US_DOMAINS], ...Object.entries(SUFFIX_DOMAINS)];

describe('the curated domain table', () => {
  it('has a few hundred entries', () => {
    const count = new Set(allTables().flatMap(([group, table]) => Object.keys(table).map((ticker) => `${group}:${ticker}`))).size;
    expect(count).toBeGreaterThanOrEqual(300);
  });

  it.each(allTables())('%s: every key is an upper-case ticker and every value a bare lower-case domain', (_group, table) => {
    for (const [ticker, domain] of Object.entries(table)) {
      expect(ticker, ticker).toMatch(TICKER_FORMAT);
      expect(domain, `${ticker} -> ${domain}`).toMatch(DOMAIN_FORMAT);
      expect(normalizeDomain(domain), domain).toBe(domain);
    }
  });

  it('lists the issuer domains in the same format', () => {
    for (const [prefix, domain] of Object.entries(ISSUER_DOMAINS)) {
      expect(prefix).toBe(prefix.toLowerCase());
      expect(domain).toMatch(DOMAIN_FORMAT);
    }
  });
});

describe('normalizeDomain', () => {
  it.each([
    ['apple.com', 'apple.com'],
    ['  Apple.COM ', 'apple.com'],
    ['https://www.apple.com/mac?x=1#top', 'apple.com'],
    ['http://about.meta.com', 'about.meta.com'],
    ['www.sap.com.', 'sap.com'],
    ['ishares.com/en', 'ishares.com'],
    ['xn--bcher-kva.ch', 'xn--bcher-kva.ch'],
  ])('%j -> %j', (input, expected) => expect(normalizeDomain(input)).toBe(expected));

  it.each([
    '',
    '   ',
    'localhost',
    'apple',
    '127.0.0.1',
    '10.0.0.1:8080',
    'https://user:pw@apple.com',
    'apple.com:443',
    'bücher.de',
    '-bad.com',
    'bad-.com',
    'a..com',
    'apple.c',
    'apple.123',
    `${'a'.repeat(64)}.com`,
    `${'a.'.repeat(130)}com`,
    'a'.repeat(301),
    'not a domain.com',
    '/path/only',
  ])('rejects %j', (input) => expect(normalizeDomain(input)).toBeUndefined());
});

describe('splitLogoSymbol', () => {
  it('splits the exchange suffixes the app writes', () => {
    expect(splitLogoSymbol('SAP.DE')).toEqual({ ticker: 'SAP', suffix: 'DE' });
    expect(splitLogoSymbol('asml.as')).toEqual({ ticker: 'ASML', suffix: 'AS' });
    expect(splitLogoSymbol('NOVO-B.CO')).toEqual({ ticker: 'NOVO-B', suffix: 'CO' });
  });

  it('keeps a dot that is part of the ticker', () => {
    expect(splitLogoSymbol('BRK.B')).toEqual({ ticker: 'BRK-B' });
    expect(splitLogoSymbol('AAPL')).toEqual({ ticker: 'AAPL' });
  });
});

describe('tableDomain', () => {
  it('resolves US tickers and the exchange suffixes of one company to the same domain', () => {
    expect(tableDomain('SAP')).toBe('sap.com');
    expect(tableDomain('SAP.DE')).toBe('sap.com');
    expect(tableDomain('SAP.F')).toBe('sap.com');
    expect(tableDomain('ASML.AS')).toBe('asml.com');
    expect(tableDomain('ASML')).toBe('asml.com');
    expect(tableDomain('SHEL.L')).toBe('shell.com');
    expect(tableDomain('ENI.MI')).toBe('eni.com');
    expect(tableDomain('BRK.B')).toBe('berkshirehathaway.com');
  });

  it('keeps colliding tickers of different markets apart', () => {
    expect(tableDomain('MRK')).toBe('merck.com');
    expect(tableDomain('MRK.DE')).toBe('merckgroup.com');
    expect(tableDomain('SAN.PA')).toBe('sanofi.com');
    expect(tableDomain('SAN.MC')).toBe('santander.com');
    expect(tableDomain('BA')).toBe('boeing.com');
    expect(tableDomain('BA.L')).toBe('baesystems.com');
  });

  it('falls back to the US group for a cross-listing and knows nothing else', () => {
    expect(tableDomain('AAPL.DE')).toBe('apple.com');
    expect(tableDomain('NOVO-B.CO')).toBe('novonordisk.com');
    expect(tableDomain('ZZZZ')).toBeUndefined();
    expect(tableDomain('ZZZZ.DE')).toBeUndefined();
    expect(tableDomain('constructor')).toBeUndefined();
    expect(tableDomain('X.constructor')).toBeUndefined();
  });
});

describe('issuerDomain', () => {
  it.each([
    ['iShares Core MSCI World UCITS ETF USD (Acc)', 'ishares.com'],
    ['ISHARES(R) S&P 500', 'ishares.com'],
    ['Invesco Physical Gold A', 'invesco.com'],
    ['  VanEck Semiconductor UCITS ETF', 'vaneck.com'],
    ['WisdomTree Physical Swiss Gold', 'wisdomtree.com'],
    ['Global X Uranium', 'globalxetfs.com'],
    ['SPDR S&P 500', 'ssga.com'],
    ['Vanguard', 'vanguard.com'],
  ])('%j -> %j', (name, expected) => expect(issuerDomain(name)).toBe(expected));

  it.each([undefined, '', 'Ishare', 'iSharesX Core', 'Core iShares', 'Apple Inc.'])('knows no issuer for %j', (name) => {
    expect(issuerDomain(name)).toBeUndefined();
  });
});

describe('resolveLogoDomain precedence', () => {
  const all = { symbol: 'SAP.DE', name: 'iShares something', override: 'https://www.override.example.com/', website: 'http://www.provider.example.com' };

  it('1. the owner override wins over everything', () => {
    expect(resolveLogoDomain(all)).toEqual({ domain: 'override.example.com', source: 'override' });
  });

  it('2. the provider website comes next', () => {
    expect(resolveLogoDomain({ ...all, override: undefined })).toEqual({ domain: 'provider.example.com', source: 'provider' });
  });

  it('3. then the curated table', () => {
    expect(resolveLogoDomain({ ...all, override: undefined, website: undefined })).toEqual({ domain: 'sap.com', source: 'table' });
  });

  it('4. then the ETF issuer prefix', () => {
    expect(resolveLogoDomain({ symbol: 'IWDA.AS', name: 'iShares Core MSCI World UCITS ETF' })).toEqual({ domain: 'ishares.com', source: 'issuer' });
  });

  it('skips an invalid override or website instead of using it', () => {
    expect(resolveLogoDomain({ symbol: 'AAPL', override: 'not a domain', website: '10.0.0.1' })).toEqual({ domain: 'apple.com', source: 'table' });
  });

  it('knows nothing for an unknown symbol without an issuer name', () => {
    expect(resolveLogoDomain({ symbol: 'ZZZZ', name: 'Some Small Company' })).toBeUndefined();
    expect(resolveLogoDomain({ symbol: 'ZZZZ' })).toBeUndefined();
  });
});
