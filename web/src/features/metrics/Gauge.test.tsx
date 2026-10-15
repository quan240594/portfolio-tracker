import { render, screen, within } from '@testing-library/react';
import { Gauge, type GaugeMarker } from './Gauge';

const markers = (portfolio: number | null, benchmark: number | null): GaugeMarker[] => [
  { key: 'portfolio', label: 'Portfolio', value: portfolio, text: portfolio === null ? '' : `P${portfolio}` },
  { key: 'benchmark', label: 'Market', value: benchmark, text: benchmark === null ? '' : `M${benchmark}` },
];
const scale = { min: 0, max: 10 };
const tick = (v: number) => `${v}x`;

const left = (testId: string) => screen.getByTestId(testId).style.left;

describe('Gauge', () => {
  it('places the dots proportionally and exposes the portfolio as a native meter with a text equivalent', () => {
    render(<Gauge label="Test ratio" scale={scale} markers={markers(2.5, 7.5)} ticks={[0, 5, 10]} formatTick={tick} verdict="Verdict: fine." endLabels={['Low', 'High']} />);
    expect(left('gauge-dot-portfolio')).toBe('25%');
    expect(left('gauge-dot-benchmark')).toBe('75%');
    const meter = screen.getByRole('meter', { name: 'Test ratio, portfolio' });
    expect(meter).toHaveAttribute('min', '0');
    expect(meter).toHaveAttribute('max', '10');
    expect(meter).toHaveAttribute('value', '2.5');
    const figure = screen.getByRole('figure', { name: 'Test ratio' });
    expect(within(figure).getByText('Test ratio. Portfolio: P2.5; Market: M7.5. Scale from 0x to 10x. Verdict: fine.')).toBeInTheDocument();
    expect(screen.getByText('P2.5')).toBeInTheDocument();
    expect(screen.getByText('M7.5')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('10x')).toBeInTheDocument();
  });

  it('pins values outside the scale to the ends and keeps edge labels inside the gauge', () => {
    render(<Gauge label="Edge" scale={scale} markers={markers(-4, 99)} ticks={[0, 10]} formatTick={tick} />);
    expect(left('gauge-dot-portfolio')).toBe('0%');
    expect(left('gauge-dot-benchmark')).toBe('100%');
    expect(screen.getByRole('meter')).toHaveAttribute('value', '0');
    expect(screen.getByTestId('gauge-label-portfolio').style.left).toBe('0px');
    expect(screen.getByTestId('gauge-label-benchmark').style.right).toBe('0px');
  });

  it('omits a marker without a value, says so in the text equivalent and renders coloured bands', () => {
    const { container } = render(
      <Gauge
        label="Bands"
        scale={{ min: -1, max: 3 }}
        markers={markers(1, null)}
        bands={[
          { from: -1, to: 0, tone: 'negative' },
          { from: 0, to: 1, tone: 'caution' },
          { from: 1, to: 3, tone: 'positive' },
        ]}
        ticks={[-1, 3]}
        formatTick={tick}
      />,
    );
    expect(screen.queryByTestId('gauge-dot-benchmark')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gauge-label-benchmark')).not.toBeInTheDocument();
    expect(screen.getByText(/Market: not available/)).toBeInTheDocument();
    const widths = [...container.querySelectorAll<HTMLElement>('span[style*="width"]')].map((s) => s.style.width);
    expect(widths).toEqual(['25%', '25%', '50%']);
  });

  it('renders no meter without a portfolio value', () => {
    render(<Gauge label="Empty" scale={scale} markers={markers(null, 3)} ticks={[0]} formatTick={tick} />);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByTestId('gauge-dot-benchmark')).toBeInTheDocument();
  });
});
