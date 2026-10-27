import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { sampleSummary, type CalendarEvent } from '@portfolio/shared';
import { DEMO_EARNINGS_STATUS } from '../../mocks/earningsHandlers';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { LogosEnabledProvider, resetLogoSession } from '../../components/CompanyLogo';
import { renderWithProviders, sp } from '../../test/utils';
import { EventMarker } from './EventMarker';
import { EventList, EventRow } from './EventList';
import { MAX_CHIPS_PER_DAY, MonthGrid } from './MonthGrid';
import { DayDialog, EventDialog } from './EventDialog';
import { eventDetailLine, expectedLabel, perShareLabel } from './eventText';
import { sourceLabel, statusLabel } from './calendarModel';

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
    expect(eventDetailLine(event({ type: 'EARNINGS', earningsPhase: 'reported', period: 'Q3 2026', timeOfDay: 'AMC' }))).toBe('Earnings · Reported Q3 2026 · After market close');
    expect(eventDetailLine(event({ type: 'EARNINGS', earningsPhase: 'reported' }))).toBe('Earnings · Reported');
    expect(eventDetailLine(event({ type: 'EARNINGS', earningsPhase: 'projected' }))).toBe('Earnings · Projected date');
    expect(eventDetailLine(event({ type: 'EARNINGS', earningsPhase: 'scheduled', timeOfDay: 'BMO' }))).toBe('Earnings · Before market open');
    expect(eventDetailLine(event({ type: 'SPLIT', description: '4-for-1 stock split' }))).toBe('4-for-1 stock split');
  });
});

describe('reported and projected earnings', () => {
  const reported = event({ id: 'earn:AAPL:2026-10-14', date: '2026-10-14', type: 'EARNINGS', status: 'CONFIRMED', source: 'earnings-summary', earningsPhase: 'reported', period: 'Q3 2026', description: 'Reported results for Q3 2026', expectedAmount: undefined });
  const projected = event({ id: 'earn-est:AAPL:2027-01-13', date: '2027-01-13', type: 'EARNINGS', status: 'ESTIMATED', source: 'estimate', earningsPhase: 'projected', expectedAmount: undefined });

  it('says Reported for released results (CONFIRMED underneath) and keeps the status words of every other event', () => {
    expect(statusLabel(reported)).toBe('Reported');
    expect(statusLabel(projected)).toBe('Estimated');
    expect(statusLabel(event())).toBe('Confirmed');
    expect(statusLabel(event({ status: 'PAID' }))).toBe('Received');
  });

  it('labels the source of a projected earnings date as the previous report, and of a projected dividend as your payments', () => {
    expect(sourceLabel('estimate', 'EARNINGS')).toBe('Projected from the previous report');
    expect(sourceLabel('estimate', 'DIVIDEND_PAY')).toBe('Projected from your payment history');
    expect(sourceLabel('estimate')).toBe('Projected from your payment history');
    expect(sourceLabel('earnings-summary', 'EARNINGS')).toBe('Earnings summary (company release)');
    expect(sourceLabel('something-new')).toBe('something-new');
  });

  it('shows the Reported chip and the period in the row, and Estimated with a dashed border for a projection', () => {
    renderWithProviders(<EventList events={[reported, projected]} baseCurrency="EUR" onSelect={vi.fn()} today={TODAY} />);
    const rows = screen.getAllByRole('button');
    expect(rows[0]).toHaveAccessibleName('AAPL, Earnings, reported');
    expect(rows[0]).toHaveTextContent('Earnings · Reported Q3 2026');
    expect(within(rows[0]!).getByText('Reported')).toBeInTheDocument();
    expect(rows[1]).toHaveAccessibleName('AAPL, Earnings, estimated');
    expect(rows[1]).toHaveTextContent('Earnings · Projected date');
    expect(within(rows[1]!).getByText('Estimated')).toHaveClass('border-dashed');
  });

  it('explains a projection in the dialog and does not claim it was announced', () => {
    renderWithProviders(<EventDialog event={projected} baseCurrency="EUR" onClose={vi.fn()} withScope={(to) => to} />);
    const dialog = screen.getByRole('dialog', { name: 'AAPL · Earnings' });
    expect(dialog).toHaveTextContent('Projected date');
    expect(dialog).toHaveTextContent('Projected from the previous report');
    expect(dialog).toHaveTextContent('No date is announced yet. This is a projection from the previous report (about 91 days later)');
  });

  it('shows a reported release with its summary link on the report date', async () => {
    server.use(
      http.get(api('/earnings/status'), () => HttpResponse.json(DEMO_EARNINGS_STATUS)),
      http.get(api('/earnings'), () => HttpResponse.json({ available: true, summaries: [sampleSummary({ symbol: 'AAPL', reportDate: '2026-10-14' })], symbols: ['AAPL'] })),
    );
    renderWithProviders(<EventDialog event={reported} baseCurrency="EUR" onClose={vi.fn()} withScope={(to) => to} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Reported Q3 2026');
    expect(dialog).toHaveTextContent('StatusReported');
    expect(dialog).toHaveTextContent('Earnings summary (company release)');
    expect(dialog).not.toHaveTextContent('projection');
    expect(await screen.findByRole('link', { name: 'View summary' })).toHaveAttribute('href', '/earnings/AAPL');
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

  it('offers "View summary" in the dialog of an earnings event once a summary exists, never in a dividend dialog', async () => {
    server.use(
      http.get(api('/earnings/status'), () => HttpResponse.json(DEMO_EARNINGS_STATUS)),
      http.get(api('/earnings'), () => HttpResponse.json({ available: true, summaries: [sampleSummary({ symbol: 'AAPL', reportDate: '2026-10-21' })], symbols: ['AAPL'] })),
    );
    open(event({ type: 'EARNINGS', date: '2026-10-22', expectedAmount: undefined, status: 'ESTIMATED' }));
    expect(await screen.findByRole('link', { name: 'View summary' })).toHaveAttribute('href', '/earnings/AAPL');
    cleanup();
    open(event());
    await screen.findByRole('dialog');
    expect(screen.queryByRole('link', { name: 'View summary' })).not.toBeInTheDocument();
  });

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
    expect(dialog).toHaveTextContent('The date comes from a data provider and may change once the company confirms it.');
  });

  it('copes with missing earnings details', () => {
    open(event({ type: 'EARNINGS', epsEstimate: undefined, currency: undefined, fiscalPeriodEnd: undefined, timeOfDay: undefined }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Not specified');
    expect(within(dialog).getAllByText('Not available')).toHaveLength(2);
    expect(dialog).not.toHaveTextContent('may change');
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

describe('colour of the event type', () => {
  it('draws the ex-dividend marker violet and every other marker neutral', () => {
    const { container } = renderWithProviders(
      <>
        <EventMarker type="EX_DIVIDEND" />
        <EventMarker type="DIVIDEND_PAY" />
      </>,
    );
    const [exDividend, payment] = [...container.querySelectorAll('svg path')];
    expect(exDividend?.getAttribute('class')).toContain('fill-[#6d28d9]');
    expect(payment?.getAttribute('class')).toContain('fill-slate-700');
  });

  it('tints an ex-dividend row violet and a payment row of the same status with the status colour, both keeping the status chip', () => {
    renderWithProviders(<EventList events={[event(), event({ id: 'pay', type: 'DIVIDEND_PAY' })]} baseCurrency="EUR" onSelect={vi.fn()} today={TODAY} />);
    const [exDividend, payment] = screen.getAllByRole('button');
    expect(exDividend).toHaveAttribute('data-type', 'EX_DIVIDEND');
    expect(exDividend?.className).toContain('bg-[#e9d5ff]');
    expect(exDividend?.className).toContain('border-[#3b6fd4]');
    expect(payment).toHaveAttribute('data-type', 'DIVIDEND_PAY');
    expect(payment?.className).toContain('bg-[#dbeafe]');
    expect(payment?.className).not.toContain('bg-[#e9d5ff]');
    for (const row of [exDividend, payment]) expect(within(row as HTMLElement).getByText('Confirmed')).toBeInTheDocument();
  });

  it('keeps an estimated ex-dividend dashed with the yellow border and readable status text', () => {
    renderWithProviders(<EventList events={[event({ status: 'ESTIMATED' })]} baseCurrency="EUR" onSelect={vi.fn()} today={TODAY} />);
    const row = screen.getByRole('button');
    expect(row.className).toContain('bg-[#e9d5ff]');
    expect(row.className).toContain('border-dashed');
    expect(row.className).toContain('border-[#a16207]');
    expect(within(row).getByText('Estimated')).toHaveClass('border-dashed');
  });

  it('colours month chips by type too', () => {
    renderWithProviders(
      <MonthGrid month="2026-10" today={TODAY} events={[event(), event({ id: 'pay', type: 'DIVIDEND_PAY', symbol: 'PAY' })]} baseCurrency="EUR" onSelectEvent={vi.fn()} onSelectDay={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /^AAPL, Ex-dividend/ }).className).toContain('bg-[#e9d5ff]');
    expect(screen.getByRole('button', { name: /^PAY, Dividend payment/ }).className).toContain('bg-[#dbeafe]');
  });
});

describe('company logos in the calendar', () => {
  afterEach(() => act(() => resetLogoSession()));

  it('shows the monogram, the type as a corner marker and the type in words on a list row when logos are off', () => {
    renderWithProviders(<EventList events={[event(), event({ id: 'pay', type: 'DIVIDEND_PAY', symbol: 'SAP.DE', name: 'SAP SE' })]} baseCurrency="EUR" onSelect={vi.fn()} today={TODAY} />);
    const rows = screen.getAllByRole('button');
    expect(rows[0]).toHaveAccessibleName(/^AAPL, Ex-dividend, confirmed, €\s3,74$/);
    expect(rows[1]).toHaveAccessibleName(/^SAP\.DE, Dividend payment, confirmed/);
    for (const row of rows) {
      expect(row.querySelector('[data-logo="monogram"]')).not.toBeNull();
      expect(row.querySelector('img')).toBeNull();
      expect(row.querySelector('svg[data-shape]')).not.toBeNull();
    }
    expect(rows[0]).toHaveTextContent(/Ex-dividend · .* per share · 10 shares/);
    expect(rows[1]?.querySelector('svg')).toHaveAttribute('data-shape', 'square');
  });

  it('shows the logo image instead of the letter badge, keeping the marker, the status border and the accessible name', () => {
    renderWithProviders(
      <LogosEnabledProvider value>
        <EventList events={[event()]} baseCurrency="EUR" onSelect={vi.fn()} today={TODAY} />
      </LogosEnabledProvider>,
    );
    const row = screen.getByRole('button', { name: /^AAPL, Ex-dividend, confirmed/ });
    const img = row.querySelector('img')!;
    expect(img).toHaveAttribute('src', '/api/logos/AAPL?v=2');
    expect(img).toHaveAttribute('alt', '');
    expect(row.querySelector('svg[data-shape="circle"]')).not.toBeNull();
    expect(row).toHaveAttribute('data-status', 'CONFIRMED');
    expect(row.className).toContain('border-l-4');
  });

  it('lays a row out as logo | text column | amount, the lines in one column of their own next to the logo', () => {
    renderWithProviders(
      <LogosEnabledProvider value>
        <EventList events={[event()]} baseCurrency="EUR" onSelect={vi.fn()} today={TODAY} />
      </LogosEnabledProvider>,
    );
    const row = screen.getByRole('button', { name: /^AAPL, Ex-dividend/ });
    // The flex row is a span inside the button (a button is not a reliable flex container everywhere).
    const flex = row.querySelector('[data-row]')!;
    expect(row.className).not.toContain('flex');
    expect(flex.className).toContain('flex');
    const [logo, text, aside] = Array.from(flex.children) as HTMLElement[];
    expect(logo).toHaveAttribute('data-logo');
    expect(logo!.className).toContain('shrink-0');
    expect(logo!.querySelector('[data-logo-marker]')).not.toBeNull();
    expect(text).toHaveAttribute('data-row-text');
    expect(text!.className).toContain('min-w-0');
    expect(Array.from(text!.children).map((line) => line.getAttribute('data-row-line'))).toEqual(['title', 'detail']);
    expect(aside!.className).toContain('shrink-0');
    expect(flex.children).toHaveLength(3);
  });

  it('falls back to the monogram of a row whose image fails, without changing the row', () => {
    renderWithProviders(
      <LogosEnabledProvider value>
        <EventList events={[event()]} baseCurrency="EUR" onSelect={vi.fn()} today={TODAY} />
      </LogosEnabledProvider>,
    );
    const row = screen.getByRole('button', { name: /^AAPL, Ex-dividend/ });
    fireEvent.error(row.querySelector('img')!);
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('[data-logo="monogram"] [data-monogram]')).toHaveAttribute('data-monogram', 'AA');
    expect(row).toHaveAccessibleName(/^AAPL, Ex-dividend, confirmed/);
  });

  it('puts the logo on month chips and in the event dialog, next to the written name', () => {
    renderWithProviders(
      <LogosEnabledProvider value>
        <MonthGrid month="2026-10" today={TODAY} events={[event()]} baseCurrency="EUR" onSelectEvent={vi.fn()} onSelectDay={vi.fn()} />
        <EventDialog event={event()} baseCurrency="EUR" onClose={vi.fn()} withScope={(to) => to} />
      </LogosEnabledProvider>,
    );
    const chip = screen.getByRole('button', { name: /^AAPL, Ex-dividend/ });
    expect(chip.querySelector('img')).toHaveAttribute('src', '/api/logos/AAPL?v=2');
    expect(chip).toHaveAttribute('title', expect.stringContaining('Ex-dividend'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Apple Inc.')).toBeInTheDocument();
    expect(dialog.querySelector('img')).toHaveAttribute('alt', '');
  });
});
