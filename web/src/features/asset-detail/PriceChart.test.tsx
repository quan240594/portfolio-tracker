import { render } from '@testing-library/react';
import { MarkerShape, markerColors } from './PriceChart';

const colors = markerColors('light');

const shape = (type: 'BUY' | 'SELL' | 'DIVIDEND', cx?: number, cy?: number) =>
  render(
    <svg>
      <MarkerShape type={type} colors={colors} cx={cx} cy={cy} />
    </svg>,
  ).container.querySelector('path');

describe('MarkerShape', () => {
  it('draws a different shape per type, with the type colour', () => {
    const buy = shape('BUY', 10, 10)!;
    const sell = shape('SELL', 10, 10)!;
    const dividend = shape('DIVIDEND', 10, 10)!;
    expect(new Set([buy.getAttribute('d'), sell.getAttribute('d'), dividend.getAttribute('d')]).size).toBe(3);
    expect(buy.getAttribute('fill')).toBe(colors.BUY);
    expect(sell.getAttribute('fill')).toBe(colors.SELL);
    expect(dividend.getAttribute('fill')).toBe(colors.DIVIDEND);
  });

  it('draws nothing without a position', () => {
    expect(shape('BUY')).toBeNull();
    expect(shape('SELL', 5)).toBeNull();
  });

  it('has legible colours in the dark theme too', () => {
    expect(markerColors('dark')).not.toEqual(colors);
  });
});
