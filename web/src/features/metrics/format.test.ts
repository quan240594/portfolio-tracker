import { formatMultiple, formatMultipleTick, formatPoints, formatRatio, formatRatioTick, formatReturn, formatShare, formatVolatility, formatVolatilityTick } from './format';

describe('metrics formatting (nl-NL)', () => {
  it('formats multiples with a decimal comma and the multiplication sign', () => {
    expect(formatMultiple(25.43)).toBe('25,4×');
    expect(formatMultiple(9)).toBe('9,0×');
    expect(formatMultipleTick(70)).toBe('70×');
  });

  it('formats ratios with three decimals and a typographic minus', () => {
    expect(formatRatio(0.787)).toBe('0,787');
    expect(formatRatio(-0.12)).toBe('\u22120,120');
    expect(formatRatioTick(-1)).toBe('\u22121');
    expect(formatRatioTick(3)).toBe('3');
  });

  it('formats percentages and points', () => {
    expect(formatVolatility(12.34)).toBe('12,3%');
    expect(formatVolatilityTick(40)).toBe('40%');
    expect(formatReturn(45.9)).toBe('+45,9%');
    expect(formatReturn(-3.25)).toBe('\u22123,3%');
    expect(formatPoints(-7.8)).toBe('7,8 pp');
    expect(formatPoints(0.04)).toBe('0,0 pp');
    expect(formatShare(83.3)).toBe('83%');
  });
});
