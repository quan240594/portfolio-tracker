import { periodLabel, percentTick, ratioOrDash, signedPercentOrDash } from './labels';

describe('analytics labels', () => {
  it('labels periods', () => {
    expect(periodLabel('year', '2026')).toBe('2026');
    expect(periodLabel('quarter', '2026-Q3')).toBe('Q3 2026');
    expect(periodLabel('month', '2026-03')).toBe('Mar 26');
  });

  it('formats percentages and ratios the Dutch way, with a dash for missing values', () => {
    expect(percentTick(12)).toBe('12%');
    expect(signedPercentOrDash(12.5)).toBe('+12,50%');
    expect(signedPercentOrDash(-3.456, 1)).toBe('\u22123,5%');
    expect(signedPercentOrDash(null)).toBe('—');
    expect(signedPercentOrDash(undefined)).toBe('—');
    expect(ratioOrDash(1.234)).toBe('1,23');
    expect(ratioOrDash(-0.5)).toBe('\u22120,50');
    expect(ratioOrDash(null)).toBe('—');
  });
});
