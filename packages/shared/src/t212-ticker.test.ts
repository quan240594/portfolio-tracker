import { describe, expect, it } from 'vitest';
import { isT212Ticker } from './t212-ticker.js';

describe('isT212Ticker', () => {
  it.each(['AAPL_US_EQ', 'SMGBl_EQ', 'FOOd_EQ', 'BRK.B_US_EQ', 'A-B_1', 'a', 'x'.repeat(40)])('accepts %s', (ticker) => {
    expect(isT212Ticker(ticker)).toBe(true);
  });

  it.each(['', 'x'.repeat(41), '.', '..', '../etc', 'a/b', 'a%2Fb', 'a b', 'AAPL?x=1', 'a#b', 'é_EQ', 'a\nb', String.raw`a\b`])('rejects %j', (ticker) => {
    expect(isT212Ticker(ticker)).toBe(false);
  });

  it('rejects what is not a string', () => {
    expect(isT212Ticker(undefined)).toBe(false);
    expect(isT212Ticker(12)).toBe(false);
  });
});
