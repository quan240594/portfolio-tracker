import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CalendarEvent } from '@portfolio/shared';
import { renderWithProviders, sp } from '../../test/utils';
import { EventMarker } from './EventMarker';
import { EventList, EventRow } from './EventList';
import { MAX_CHIPS_PER_DAY, MonthGrid } from './MonthGrid';
import { DayDialog, EventDialog } from './EventDialog';
import { eventDetailLine, expectedLabel, perShareLabel } from './eventText';

const TODAY = '2026-10-15';

const event = (e: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'ex:AAPL:2026-10-20',
  date: '2026-10-20',
  type: 'EX_DIVIDEND',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  status: 'CONFIRMED',
  origin: 'HOLDING',
  source: 'market-data',
  description: '0.55 USD per share × 10 shares',
  amountPerShare: 0.55,
  currency: 'USD',
  exDate: '2026-10-20',
  payDate: '2026-11-05',
  quantity: 10,
  expectedAmount: 3.74,
  countsAsIncome: false,
  ...e,
});

describe('EventMarker', () => {
  it('draws a distinct shape and letter per type and is hidden from assistive technology', () => {
    const { container } = renderWithProviders(
      <>
        <EventMarker type="EX_DIVIDEND" />
        <EventMarker type="DIVIDEND_PAY" />
        <EventMarker type="EARNINGS" />
        <EventMarker type="SPLIT" />
        <EventMarker type="CORPORATE_ACTION" className="h-8 w-8" />
      </>,
    );
    const svgs = [...container.querySelectorAll('svg')];
    expect(svgs.map((s) => s.getAttribute('data-shape'))).toEqual(['circle', 'square', 'diamond', 'triangle', 'hexagon']);
    expect(svgs.map((s) => s.textContent)).toEqual(['E', 'P', 'R', 'S', 'C']);
    expect(svgs.every((s) => s.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(svgs[4]).toHaveClass('h-8');
  });
});

describe('event text', () => {
  it('formats amounts in euros and per-share amounts in the paying currency', () => {
    expect(expectedLabel(event(), 'EUR')).toBe(sp('€ 3,74').replace(' ', '\u00a0'));
    expect(expectedLabel(event({ expectedAmount: undefined }), 'EUR')).toBeUndefined();
    expect(perShareLabel(event())).toContain('0,55');
    expect(perShareLabel(event({ amountPerShare: undefined }))).toBeUndefined();
    expect(perShareLabel(event({ currency: undefined }))).toBeUndefined();
  });

  it('describes each kind of event on one line', () => {
    expect(sp(eventDetailLine(event()))).toBe(sp('Ex-dividend · US$ 0,55 per share · 10 shares'));
    expect(eventDetailLine(event({ amountPerShare: undefined, quantity: undefined }))).toBe('Ex-dividend');
    expect(eventDetailLine(event({ type: 'EARNINGS', timeOfDay: 'AMC' }))).toBe('Earnings · After market close');
    expect(eventDetailLine(event({ type: 'EARNINGS', timeOfDay: 'BMO' }))).toBe('Earnings · Before market open');
    expect(eventDetailLine(event({ type: 'EARNINGS', timeOfDay: 'unknown' }))).toBe('Earnings');
    expect(eventDetailLine(event({ type: 'EARNINGS' }))).toBe('Earnings');
    expect(eventDetailLine(event({ type: 'SPLIT', description: '4-for-1 stock split' }))).toBe('4-for-1 stock split');
  });
});

describe('MonthGrid', () => {
  const onSelectEvent = vi.fn();
  const onSelectDay = vi.fn();
  const grid = (events: CalendarEvent[], month = '2026-10') =>
    renderWithProviders(<MonthGrid month={month} today={TODAY} events={events} baseCurrency="EUR" onSelectEvent={onSelectEvent} onSelectDay={onSelectDay} />);

  it('is a table with Monday-first column headers and one cell per day', () => {
    grid([]);
    const table = screen.getByRole('table', { name: /Calendar events in October 2026, Monday to Sunday/ });
    const headers = within(table).getAllByRole('columnheader');
    expect(headers).toHaveLength(7);
    expect(headers[0]).toHaveAttribute('abbr', 'Monday');
    expect(headers[6]).toHaveAttribute('abbr', 'Sunday');
    expect(headers.every((h) => h.getAttribute('scope') === 'col')).toBe(true);
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 5);
    expect(table.querySelectorAll('td')).toHaveLength(35);
  });

  it('marks today and dims the days of the neighbouring months', () => {
    const { container } = grid([]);
    const current = container.querySelector('[aria-current="date"]')!;
    expect(current).toHaveTextContent('15');
    expect(current.closest('td')).toHaveAttribute('data-date', TODAY);
    expect(container.querySelectorAll('[aria-current]')).toHaveLength(1);
    expect(container.querySelector('td[data-date="2026-09-28"]')).toHaveClass('opacity-70');
    expect(container.querySelector('td[data-date="2026-10-10"]')).not.toHaveClass('opacity-70');
  });

  it('shows chips with symbol, type and the amount in euros of dividends, and opens an event on click', async () => {
    grid([event(), event({ id: 'earn', type: 'EARNINGS', symbol: 'MSFT', date: '2026-10-21', expectedAmount: undefined, status: 'ESTIMATED' })]);
    const dividend = screen.getByRole('button', { name: /^AAPL, Ex-dividend, confirmed, €/ });
    expect(dividend).toHaveTextContent('AAPL');
    expect(dividend).toHaveTextContent(sp('€ 3,74'));
    const earnings = screen.getByRole('button', { name: 'MSFT, Earnings, estimated' });
    expect(earnings).toHaveClass('border-dashed', 'italic');
    expect(earnings).not.toHaveTextContent('€');
    await userEvent.click(dividend);
    expect(onSelectEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'ex:AAPL:2026-10-20' }));
  });

  it('collapses days with more than three events into "+N more"', async () => {
    const day = Array.from({ length: MAX_CHIPS_PER_DAY + 2 }, (_, i) => event({ id: `e${i}`, symbol: `S${i}`, type: 'EARNINGS', expectedAmount: undefined }));
    grid(day);
    expect(screen.getAllByRole('button', { name: /Earnings/ })).toHaveLength(MAX_CHIPS_PER_DAY);
    const more = screen.getByRole('button', { name: '2 more on 20-10-2026' });
    expect(more).toHaveTextContent('+2 more');
    await userEvent.click(more);
    expect(onSelectDay).toHaveBeenCalledWith('2026-10-20');
  });

  it('shows no overflow button for exactly three events', () => {
    grid(Array.from({ length: 3 }, (_, i) => event({ id: `e${i}`, symbol: `S${i}` })));
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });

  it('shows events of the neighbouring months inside the grid', () => {
    grid([event({ id: 'sep', date: '2026-09-30', symbol: 'ZZZ' })]);
    expect(screen.getByRole('button', { name: /^ZZZ,/ }).closest('td')).toHaveAttribute('data-date', '2026-09-30');
  });

  it('renders six-week months', () => {
    grid([], '2026-08');
    expect(screen.getAllByRole('row')).toHaveLength(1 + 6);
  });
});

describe('EventList', () => {
  const events = [
    event({ id: 'a', date: '2026-10-15', status: 'PAID', type: 'DIVIDEND_PAY', expectedAmount: 3.4 }),
    event({ id: 'b', date: '2026-10-15', type: 'EARNINGS', expectedAmount: undefined, timeOfDay: 'BMO', status: 'ESTIMATED', name: 'AAPL' }),
    event({ id: 'c', date: '2026-10-20', type: 'SPLIT', description: '4-for-1 stock split', expectedAmount: undefined }),
  ];

  it('groups events under a heading per date and marks today', async () => {
    const onSelect = vi.fn();
    renderWithProviders(<EventList events={events} baseCurrency="EUR" onSelect={onSelect} today="2026-10-15" />);
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(['Thursday, 15-10-2026Today', 'Tuesday, 20-10-2026']);
    const first = screen.getByRole('region', { name: /Thursday, 15-10-2026/ });
    expect(within(first).getAllByRole('listitem')).toHaveLength(2);
    expect(first).toHaveTextContent('Received');
    expect(first).toHaveTextContent('Estimated');
    expect(within(first).getAllByText('Received', { exact: false })).toHaveLength(2);
    await userEvent.click(within(first).getByRole('button', { name: /AAPL, Earnings, estimated/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });

  it('prints the company name only when it differs from the symbol', () => {
    renderWithProviders(<ul><EventRow event={events[0]!} baseCurrency="EUR" onSelect={vi.fn()} /><EventRow event={events[1]!} baseCurrency="EUR" onSelect={vi.fn()} /></ul>);
    const [named, bare] = screen.getAllByRole('listitem');
    expect(named).toHaveTextContent('Apple Inc.');
    expect(bare).not.toHaveTextContent('AAPL AAPL');
  });
});

describe('EventDialog', () => {
  const withScope = (to: string) => `${to}?portfolio=all`;
  const open = (e: CalendarEvent | null, onClose = vi.fn()) => {
    renderWithProviders(<EventDialog event={e} baseCurrency="EUR" onClose={onClose} withScope={withScope} />);
    return onClose;
  };

  it('renders nothing without an event', () => {
    open(null);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the dates, per-share amount, quantity and expected amount of a dividend', () => {
    open(event());
    const dialog = screen.getByRole('dialog', { name: 'AAPL · Ex-dividend' });
    expect(dialog).toHaveAccessibleDescription('Tuesday, 20-10-2026');
    const terms = within(dialog).getAllByRole('term').map((t) => t.textContent);
    expect(terms).toEqual(['Type', 'Date', 'Ex-dividend date', 'Payment date', 'Per share', 'Your shares on the ex-date', 'Expected (net)', 'Status', 'Source']);
    expect(dialog).toHaveTextContent('05-11-2026');
    expect(dialog).toHaveTextContent(sp('€ 3,74'));
    expect(dialog).toHaveTextContent('Market data provider');
    expect(dialog).toHaveTextContent('Confirmed');
    expect(within(dialog).getByRole('link', { name: 'View in holdings' })).toHaveAttribute('href', '/holdings?portfolio=all');
  });

  it('describes received and not yet announced dividends and watchlist symbols', () => {
    open(event({ status: 'PAID', type: 'DIVIDEND_PAY', exDate: undefined, payDate: undefined, source: 'transactions' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Not available');
    expect(dialog).toHaveTextContent('Not announced');
    expect(dialog).toHaveTextContent('Received (net)');
    expect(dialog).toHaveTextContent('Shares paid on');
    expect(dialog).toHaveTextContent('Your transactions');
  });

  it('explains that a watchlist dividend has no amount', () => {
    open(event({ origin: 'WATCHLIST', quantity: undefined, expectedAmount: undefined, amountPerShare: undefined, currency: undefined }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Not held: on your watchlist only');
    expect(dialog).toHaveTextContent('Not available');
    expect(within(dialog).getByRole('link', { name: 'View on watchlist' })).toHaveAttribute('href', '/watchlist?portfolio=all');
  });

  it('shows EPS estimate, fiscal period and time of day of an earnings report and warns about estimates', () => {
    open(event({ type: 'EARNINGS', status: 'ESTIMATED', source: 'alphavantage', fiscalPeriodEnd: '2026-09-30', epsEstimate: 1.85, currency: 'USD', timeOfDay: 'AMC' }));
    const dialog = screen.getByRole('dialog', { name: 'AAPL · Earnings' });
    expect(dialog).toHaveTextContent('30-09-2026');
    expect(dialog).toHaveTextContent(sp('US$ 1,85'));
    expect(dialog).toHaveTextContent('After market close');
    expect(dialog).toHaveTextContent('Alpha Vantage');
    expect(dialog).toHaveTextContent('This date is a projection');
  });

  it('copes with missing earnings details', () => {
    open(event({ type: 'EARNINGS', epsEstimate: undefined, currency: undefined, fiscalPeriodEnd: undefined, timeOfDay: undefined }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Not specified');
    expect(within(dialog).getAllByText('Not available')).toHaveLength(2);
    expect(dialog).not.toHaveTextContent('This date is a projection');
  });

  it('shows the ratio of a split and of other corporate actions', () => {
    open(event({ type: 'SPLIT', description: '4-for-1 stock split', source: 'eodhd', splitFrom: 1, splitTo: 4 }));
    expect(screen.getByRole('dialog')).toHaveTextContent('4-for-1 stock split');
    expect(screen.getByRole('dialog')).toHaveTextContent('EODHD');
  });

  it('closes with the button, the link and Escape', async () => {
    const onClose = open(event());
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('link', { name: 'View in holdings' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('DayDialog', () => {
  it('lists the events of the day and opens one', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(<DayDialog date="2026-10-20" events={[event({ id: 'a' }), event({ id: 'b', symbol: 'MSFT' })]} baseCurrency="EUR" onClose={onClose} onSelect={onSelect} />);
    const dialog = screen.getByRole('dialog', { name: 'Tuesday, 20-10-2026' });
    expect(dialog).toHaveAccessibleDescription('2 events');
    await userEvent.click(within(dialog).getByRole('button', { name: /^MSFT,/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing without a date', () => {
    renderWithProviders(<DayDialog date={null} events={[]} baseCurrency="EUR" onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
