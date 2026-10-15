import { DASH, MARKER_LABELS, MONOGRAM_CLASSES, assetPath, formatBigMoney, formatRatio, initialsOf, monogramClass, uniqueKeys } from './assetFormat';
import { sp } from '../../test/utils';

describe('assetFormat', () => {
  it('builds the encoded detail path', () => {
    expect(assetPath('ASML.AS')).toBe('/assets/ASML.AS');
    expect(assetPath('BTC-EUR')).toBe('/assets/BTC-EUR');
    expect(assetPath('A B/C')).toBe('/assets/A%20B%2FC');
  });

  it('takes initials from the first two words, else from the symbol', () => {
    expect(initialsOf('Apple Inc.', 'AAPL')).toBe('AI');
    expect(initialsOf('ASML Holding N.V.', 'ASML.AS')).toBe('AH');
    expect(initialsOf('Bitcoin', 'BTC-EUR')).toBe('BT');
    expect(initialsOf('123 456', 'xyz')).toBe('XY');
    expect(initialsOf('', 'q')).toBe('Q');
  });

  it('keeps a stable colour per symbol', () => {
    expect(monogramClass('AAPL')).toBe(monogramClass('AAPL'));
    expect(MONOGRAM_CLASSES).toContain(monogramClass('ASML.AS'));
    expect(new Set(['AAPL', 'MSFT', 'KO', 'JNJ', 'ASML.AS', 'BTC-EUR', 'SAP.DE'].map(monogramClass)).size).toBeGreaterThan(1);
    expect(MONOGRAM_CLASSES).toContain(monogramClass(''));
  });

  it('formats figures the Dutch way', () => {
    expect(DASH).toBe('—');
    expect(sp(formatBigMoney(3_450_000_000_000, 'USD'))).toMatch(/^US\$ 3,5 bln\.$/);
    expect(formatRatio(35.62)).toBe('35,62');
    expect(formatRatio(35.62, 1)).toBe('35,6');
    expect(MARKER_LABELS).toEqual({ BUY: 'Buy', SELL: 'Sell', DIVIDEND: 'Dividend' });
  });
});

describe('uniqueKeys', () => {
  it('keeps unique keys and numbers repeats', () => {
    expect(uniqueKeys(['a', 'b', 'a', 'a'], (x) => x)).toEqual(['a', 'b', 'a#1', 'a#2']);
    expect(uniqueKeys([], (x: string) => x)).toEqual([]);
  });
});
