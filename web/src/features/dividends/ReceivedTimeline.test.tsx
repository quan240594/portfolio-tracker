import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, sp } from '../../test/utils';
import { formatMoney } from '../../lib/format';
import { incomeColours } from '../calendar/calendarColours';
import { AverageNote, FixedAxis, ReceivedFutureTooltip, ReceivedTimeline, TimelineTable, UpcomingLabel } from './ReceivedTimeline';
import { useSeriesSelection } from '../../components/charts/selection';
import { chartRows, niceAxis, periodRowId, type TimelinePeriod } from './receivedFuture';
import { ChartFrame } from './chartParts';

const period = (over: Partial<TimelinePeriod>): TimelinePeriod => ({
  key: 1,
  label: 'Q4 26',
  phase: 'current',
  paid: 10,
  declared: 20,
  estimated: 5,
  total: 35,
  holdings: [
    { symbol: 'AAA', amount: 25 },
    { symbol: 'BBB', amount: 10 },
  ],
  ...over,
});
const periods: TimelinePeriod[] = [
  period({ key: 1, label: 'Q2 26', phase: 'past', paid: 40, declared: 0, estimated: 0, total: 40, holdings: [] }),
  period({ key: 2, label: 'Q3 26', phase: 'past', paid: 20, declared: 0, estimated: 0, total: 20, holdings: [] }),
  period({ key: 3 }),
  period({ key: 4, label: 'Q1 27', phase: 'upcoming', paid: 0, declared: 0, estimated: 8, total: 8, holdings: [{ symbol: 'AAA', amount: 8 }] }),
];
const money = (v: number) => sp(formatMoney(v, 'EUR'));

describe('ReceivedFutureTooltip', () => {
  const colours = incomeColours('light');
  const props = { currency: 'EUR', colours, background: '#fff', border: '#ccc', text: '#000', withFuture: true } as const;
  const row = { ...period({}), barLabel: '€ 35' };

  it('names the phase, lists the amount per status with the total and the holdings behind it', () => {
    renderWithProviders(<ReceivedFutureTooltip {...props} active payload={[{ payload: row }]} />);
    const tip = screen.getByTestId('received-future-tooltip');
    expect(tip).toHaveTextContent('Q4 26 · Current');
    for (const [name, amount] of [['Received', 10], ['Declared', 20], ['Estimated', 5], ['Total', 35]] as const) {
      expect(within(tip).getByText(name).parentElement).toHaveTextContent(money(amount));
    }
    const holdings = within(screen.getByTestId('received-future-tooltip-holdings')).getAllByRole('listitem');
    expect(holdings.map((h) => sp(h.textContent!))).toEqual([`AAA${money(25)}`, `BBB${money(10)}`]);
    expect(tip).not.toHaveTextContent('more');
  });

  it('caps a long holding list and omits the breakdown when there is none', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ symbol: `S${i}`, amount: 9 - i }));
    const { rerender } = renderWithProviders(<ReceivedFutureTooltip {...props} active payload={[{ payload: { ...row, holdings: many } }]} />);
    expect(within(screen.getByTestId('received-future-tooltip-holdings')).getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByText('+ 3 more')).toBeInTheDocument();
    rerender(<ReceivedFutureTooltip {...props} active payload={[{ payload: { ...row, holdings: [] } }]} />);
    expect(screen.queryByText('By holding')).not.toBeInTheDocument();
  });

  it('shows the plain label without the future, and nothing when inactive', () => {
    const { rerender } = renderWithProviders(<ReceivedFutureTooltip {...props} withFuture={false} active payload={[{ payload: row }]} />);
    expect(screen.getByTestId('received-future-tooltip')).toHaveTextContent(/^Q4 26/);
    expect(screen.getByTestId('received-future-tooltip')).not.toHaveTextContent('Current');
    rerender(<ReceivedFutureTooltip {...props} active={false} payload={[{ payload: row }]} />);
    expect(screen.queryByTestId('received-future-tooltip')).not.toBeInTheDocument();
    rerender(<ReceivedFutureTooltip {...props} active payload={[]} />);
    expect(screen.queryByTestId('received-future-tooltip')).not.toBeInTheDocument();
  });
});

describe('chart text parts', () => {
  it('writes "Upcoming" above the band, defaulting to the origin without a view box', () => {
    const { container } = render(
      <svg>
        <UpcomingLabel viewBox={{ x: 100, y: 50 }} fill="#111" />
        <UpcomingLabel fill="#111" />
      </svg>,
    );
    const [placed, origin] = [...container.querySelectorAll('text')];
    expect(placed).toHaveTextContent('Upcoming');
    expect(placed).toHaveAttribute('x', '106');
    expect(placed).toHaveAttribute('y', '26');
    expect(origin).toHaveAttribute('x', '6');
  });

  it('states what the avg line is, per granularity, or why there is none', () => {
    const { rerender } = render(<AverageNote average={32} currency="EUR" granularity="quarter" />);
    expect(screen.getByTestId('received-average-note')).toHaveTextContent(sp(`average received per completed quarter in this view: ${formatMoney(32, 'EUR')}`));
    rerender(<AverageNote average={null} currency="EUR" granularity="year" />);
    expect(screen.getByTestId('received-average-note')).toHaveTextContent('No completed year yet, so there is no average line.');
  });

  it('draws the axis next to the chart without anything else', () => {
    const rows = chartRows(periods, 'EUR', 44);
    const { container } = renderWithProviders(
      <div style={{ width: 100, height: 100 }}>
        <FixedAxis rows={rows} scale={niceAxis(40)} currency="EUR" />
      </div>,
    );
    expect(container.querySelector('.recharts-responsive-container')).toBeInTheDocument();
  });
});

function TableHarness({ periods: rows, withFuture }: Readonly<{ periods: TimelinePeriod[]; withFuture: boolean }>) {
  const selection = useSeriesSelection(['paid'], rows.map((p) => periodRowId('quarter', p)));
  return <TimelineTable periods={rows} currency="EUR" withFuture={withFuture} granularity="quarter" selection={selection} />;
}

describe('TimelineTable', () => {
  it('has Period, Received, Declared, Estimated and Total columns and names the phase of the future rows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TableHarness periods={periods} withFuture />);
    await user.click(screen.getByText('Show data table'));
    const table = screen.getByRole('table', { name: 'Dividends received and upcoming per period' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Period', 'Received', 'Declared', 'Estimated', 'Total']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['Q2 26', 'Q3 26', 'Q4 26 · Current', 'Q1 27 · Upcoming']);
    expect(rows[3]).toHaveTextContent(money(8));
    expect(sp(within(rows[2]!).getByRole('rowheader').textContent!)).toBe('Q4 26 · Current');
    expect(within(rows[2]!).getAllByRole('cell').map((c) => sp(c.textContent!))).toEqual([money(10), money(20), money(5), money(35)]);
  });

  it('is Period and Received only without the future', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TableHarness periods={periods.slice(0, 2)} withFuture={false} />);
    await user.click(screen.getByText('Show data table'));
    const table = screen.getByRole('table', { name: 'Dividends received per period' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Period', 'Received']);
  });
});

describe('ReceivedTimeline', () => {
  it('sums received and upcoming in its accessible label and lists the statuses and the average in the legend', () => {
    renderWithProviders(<ReceivedTimeline periods={periods} currency="EUR" granularity="quarter" upcoming={{ total: 33, declared: 20, estimated: 13 }} />);
    expect(sp(screen.getByTestId('received-time-chart').getAttribute('aria-label')!)).toBe(
      sp(
        `Dividends received over time: 4 bars, ${formatMoney(70, 'EUR')} received, ${formatMoney(33, 'EUR')} upcoming (${formatMoney(20, 'EUR')} declared, ${formatMoney(13, 'EUR')} estimated), average ${formatMoney(30, 'EUR')} received per completed quarter.`,
      ),
    );
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Received', 'Declared', 'Estimated', 'avg']);
    expect(screen.getByTestId('received-average-note')).toHaveTextContent('average received per completed quarter');
  });

  it('is the received history only, without the future legend entries and columns', () => {
    renderWithProviders(<ReceivedTimeline periods={periods.slice(0, 2)} currency="EUR" granularity="month" />);
    expect(screen.getByTestId('received-time-chart').getAttribute('aria-label')).not.toContain('upcoming');
    expect(within(screen.getByTestId('received-legend')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Received', 'avg']);
  });

  it('has no average clause without a completed period', () => {
    renderWithProviders(<ReceivedTimeline periods={periods.slice(2, 3)} currency="EUR" granularity="month" upcoming={{ total: 25, declared: 20, estimated: 5 }} />);
    expect(screen.getByTestId('received-time-chart').getAttribute('aria-label')).not.toContain('average');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('ChartFrame', () => {
  const sizes = { scrollWidth: 1000, clientWidth: 200 };
  const original = { scrollWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'), clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth') };
  beforeEach(() => {
    for (const [key, value] of Object.entries(sizes)) Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
  });
  afterEach(() => {
    for (const key of ['scrollWidth', 'clientWidth'] as const) {
      const descriptor = original[key];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, key);
    }
  });

  it('scrolls the focused bar to the middle of a wide chart and keeps the axis outside the scroller', () => {
    render(
      <ChartFrame label="Chart" testId="c" bars={10} focusBar={5} axis={<span>axis</span>}>
        <span>bars</span>
      </ChartFrame>,
    );
    const scroller = screen.getByTestId('c').parentElement!;
    expect(scroller.scrollLeft).toBe(450); // bar 5 is centred: 5.5 × 100 − 200 / 2
    expect(scroller).not.toContainElement(screen.getByText('axis'));
    expect(screen.getByText('axis').parentElement).toHaveAttribute('aria-hidden', 'true');
  });

  it('stays at the start without a focused bar', () => {
    render(
      <ChartFrame label="Chart" testId="c" bars={10}>
        <span>bars</span>
      </ChartFrame>,
    );
    expect(screen.getByTestId('c').parentElement!.scrollLeft).toBe(0);
  });
});
