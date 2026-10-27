import { describe, expect, it } from 'vitest';
import { TICKER_ALIASES, significantWords } from './ticker-aliases.js';

describe('ticker aliases', () => {
  it.each([
    ['FOO', 'CRM'],
    ['M4I', 'MA'],
    ['NFC', 'NFLX'],
    ['ADB', 'ADBE'],
  ])('%s (a German listing spelling) is %s', (listing, ticker) => {
    expect(TICKER_ALIASES.get(listing)).toBe(ticker);
  });

  it('reduces a company name to the words that tell companies apart', () => {
    expect(significantWords('The Coca-Cola Company, Inc.')).toEqual(['coca', 'cola']);
    expect(significantWords('ASML Holding N.V.')).toEqual(['asml']);
    expect(significantWords('  ')).toEqual([]);
  });
});
