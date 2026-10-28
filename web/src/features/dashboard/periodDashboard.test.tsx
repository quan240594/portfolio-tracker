import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { computeAnalyticsSummary, type CalendarEvent, type DashboardPeriod, type GetCalendarResponse, type PeriodPerformance } from '@portfolio/shared';
import { DashboardPage } from '../../pages/DashboardPage';
import { renderWithProviders, sp } from '../../test/utils';
import { server } from '../../mocks/server';
import { getAnalyticsData } from '../../mocks/db';
import { formatDate, formatMoney, formatMonthYear } from '../../lib/format';
import { monthGrid } from '../calendar/calendarModel';
import { PERIOD_STORAGE_KEY } from './dashboardPeriod';

const SUMMARY = '/api/analytics/summary';
const CALENDAR = '/api/calendar';

const periodFigures = (period: DashboardPeriod, over: Partial<PeriodPerformance> = {}): PeriodPerformance => ({
  period,
  from: '2026-01-01',
  to: '2026-10-15',
  truncated: false,
  days: 288,
  irrPct: 7.5,
  irrAnnualised: false,
  twrPct: 6.25,
  twrAnnualisedPct: null,
  startValue: 1000,
  endValue: 1200,
  dividends: 42.5,
  realizedPnl: 17.25,
  totalReturn: 123.45,
  totalReturnPct: 9.5,
  ...over,
});

/** Answers GET /analytics/summary like the API: the all-time summary, plus `periodPerformance` when `?period=` is present. */
function serveSummary(figures: (period: DashboardPeriod) => PeriodPerformance, requests: (string | null)[] = []) {
  server.use(
    http.get(SUMMARY, ({ request }) => {
      const period = new URL(request.url).searchParams.get('period') as DashboardPeriod | null;
      requests.push(period);
      return HttpResponse.json({ ...computeAnalyticsSummary(getAnalyticsData()), ...(period && { periodPerformance: figures(period) }) });
    }),
  );
  return requests;
}

const card = (name: string) => screen.getByRole('region', { name });
const periodGroup = () => screen.getByRole('radiogroup', { name: 'Period' });

afterEach(() => localStorage.clear());

describe('dashboard period toggle', () => {
  it('offers the five periods, with all time selected, and leaves the all-time requests as they were', async () => {
    const requests = serveSummary((p) => periodFigures(p));
    renderWithProviders(<DashboardPage />);
    const options = within(periodGroup()).getAllByRole('radio');
    expect(options.map((o) => o.textContent)).toEqual(['TTM', 'YTD', '5 years', '10 years', 'All time']);
    expect(within(periodGroup()).getByRole('radio', { name: 'All time' })).toHaveAttribute('aria-checked', 'true');
    await screen.findByRole('img', { name: /^Portfolio value from/ });
    await waitFor(() => expect(card('Money-weighted return (IRR)')).not.toHaveAttribute('aria-busy'));
    expect(requests).toEqual([null]);
    expect(card('Dividends received')).toHaveTextContent('Net of withholding tax, all time');
  });

  it('shows the figures of the chosen period on the period cards and remembers the choice', async () => {
    const user = userEvent.setup();
    const requests = serveSummary((p) => periodFigures(p));
    const { unmount } = renderWithProviders(<DashboardPage />);
    await user.click(within(periodGroup()).getByRole('radio', { name: 'YTD' }));

    await waitFor(() => expect(card('Total return')).toHaveTextContent(sp(formatMoney(123.45, 'EUR', { signed: true }))));
    expect(requests).toContain('ytd');
    expect(card('Total return')).toHaveTextContent('Year to date');
    expect(card('Total return')).toHaveTextContent(`Incl. ${sp(formatMoney(17.25, 'EUR', { signed: true }))} realized`);
    expect(card('Dividends received').querySelector('[data-testid="kpi-value"]')).toHaveTextContent(sp(formatMoney(42.5, 'EUR')));
    expect(card('Dividends received')).toHaveTextContent('Net of withholding tax · Year to date');
    expect(card('Realized P&L').querySelector('[data-testid="kpi-value"]')).toHaveTextContent(sp(formatMoney(17.25, 'EUR', { signed: true })));
    expect(card('Money-weighted return (IRR)')).toHaveTextContent(`Since ${formatDate('2026-01-01')} · under a year, so not annualised`);
    expect(card('Time-weighted return (TWR)')).toHaveTextContent(`Since ${formatDate('2026-01-01')} · excludes deposits and withdrawals`);
    expect(localStorage.getItem(PERIOD_STORAGE_KEY)).toBe('ytd');

    unmount();
    renderWithProviders(<DashboardPage />);
    expect(within(periodGroup()).getByRole('radio', { name: 'YTD' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(card('Total return')).toHaveTextContent(sp(formatMoney(123.45, 'EUR', { signed: true }))));
  });

  it('shows the real range when the history is shorter than the period', async () => {
    localStorage.setItem(PERIOD_STORAGE_KEY, '10y');
    serveSummary((p) => periodFigures(p, { from: '2025-02-03', truncated: true, irrAnnualised: true }));
    renderWithProviders(<DashboardPage />);
    const since = `Since ${formatDate('2025-02-03')}, the start of your history (shorter than the period)`;
    await waitFor(() => expect(card('Total return')).toHaveTextContent(since));
    expect(card('Money-weighted return (IRR)')).toHaveTextContent(`Per year, since ${formatDate('2025-02-03')} · ${since}`);
    expect(card('Time-weighted return (TWR)')).toHaveTextContent(since);
  });

  it('marks the cards that ignore the period with a quiet note, not with visible text', async () => {
    serveSummary((p) => periodFigures(p));
    renderWithProviders(<DashboardPage />);
    await waitFor(() => expect(card('Passive income (next 12 months)')).not.toHaveAttribute('aria-busy'));
    for (const name of ['Total value', 'Day change', 'Unrealized P&L', 'Currency effect', 'Passive income (next 12 months)']) {
      expect(card(name)).toHaveAttribute('title', 'Not affected by period');
      expect(card(name)).toHaveAccessibleDescription('Not affected by period');
    }
    for (const name of ['Dividend yield (TTM)', 'Dividend growth (TTM)']) {
      expect(card(name)).toHaveAttribute('title', 'Always the trailing 12 months, whatever period is selected');
    }
    for (const name of ['Total return', 'Dividends received', 'Realized P&L', 'Money-weighted return (IRR)', 'Time-weighted return (TWR)']) {
      expect(card(name)).not.toHaveAttribute('title');
    }
  });

  it('reports a failed period without touching the snapshot cards', async () => {
    localStorage.setItem(PERIOD_STORAGE_KEY, 'ttm');
    server.use(http.get(SUMMARY, ({ request }) => (new URL(request.url).searchParams.has('period') ? HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 }) : HttpResponse.json(computeAnalyticsSummary(getAnalyticsData())))));
    renderWithProviders(<DashboardPage />);
    await waitFor(() => expect(card('Total return')).toHaveTextContent('Could not load this period'));
    expect(card('Realized P&L')).toHaveTextContent('Could not load this period');
    expect(card('Total return').querySelector('[data-testid="kpi-value"]')).toHaveTextContent('—');
    expect(card('Total value').querySelector('[data-testid="kpi-value"]')).not.toHaveTextContent('—');
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
  });
});

const TODAY_NOON = '2026-10-15T10:00:00Z';

const payment = (id: string, date: string, amount: number, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  date,
  type: 'DIVIDEND_PAY',
  symbol: id.toUpperCase(),
  name: `${id} Inc.`,
  status: 'CONFIRMED',
  origin: 'HOLDING',
  source: 'market-data',
  description: 'Dividend',
  expectedAmount: amount,
  countsAsIncome: true,
  ...over,
});

const calendarResponse = (events: CalendarEvent[], from: string, to: string): GetCalendarResponse => ({
  baseCurrency: 'EUR',
  from,
  to,
  events,
  summary: { annualIncome: 0, monthlyAverage: 0, dailyAverage: 0, yieldPct: 0, yieldOnCostPct: 0, declared: 0, estimated: 0 },
  monthly: [],
  coverage: { earnings: 'ok', corporateActions: 'ok' },
});

function serveCalendar(events: CalendarEvent[]) {
  const urls: URL[] = [];
  server.use(
    http.get(CALENDAR, ({ request }) => {
      const url = new URL(request.url);
      urls.push(url);
      const from = url.searchParams.get('from')!;
      const to = url.searchParams.get('to')!;
      return HttpResponse.json(calendarResponse(events.filter((e) => e.date >= from && e.date <= to), from, to));
    }),
  );
  return urls;
}

describe('projected rest of year', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(TODAY_NOON) }));
  afterEach(() => vi.useRealTimers());

  it('adds the declared and estimated dividends from today to 31 December, whatever the period', async () => {
    const urls = serveCalendar([
      payment('aaa', '2026-10-20', 10.5),
      payment('bbb', '2026-12-31', 4.25, { status: 'ESTIMATED' }),
      payment('ccc', '2026-10-01', 99, { status: 'PAID' }),
      payment('ddd', '2027-01-05', 77),
    ]);
    serveSummary((p) => periodFigures(p));
    localStorage.setItem(PERIOD_STORAGE_KEY, '5y');
    renderWithProviders(<DashboardPage />);

    const line = () => card('Dividends received').querySelector('[title^="Declared and estimated"]');
    await waitFor(() => expect(line()).toHaveTextContent(`Projected rest of year: ${sp(formatMoney(14.75, 'EUR'))}`));
    expect(line()).toHaveAttribute('title', `Declared and estimated dividends still to be received until ${formatDate('2026-12-31')}; not affected by the period`);
    const own = urls.find((u) => u.searchParams.get('to') === '2026-12-31')!;
    expect(own.searchParams.get('from')).toBe('2026-10-15');
    expect(own.searchParams.get('status')).toBe('CONFIRMED,ESTIMATED');
    expect(own.searchParams.get('scope')).toBe('holdings');
  });

  it('says so when the calendar cannot be loaded', async () => {
    server.use(http.get(CALENDAR, () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 })));
    renderWithProviders(<DashboardPage />);
    await waitFor(() => expect(card('Dividends received')).toHaveTextContent('Projected rest of year: unavailable'));
  });

  it('shows no amount while the calendar is loading', async () => {
    server.use(http.get(CALENDAR, () => new Promise<never>(() => {})));
    renderWithProviders(<DashboardPage />);
    await waitFor(() => expect(card('Dividends received')).not.toHaveAttribute('aria-busy'));
    expect(card('Dividends received')).toHaveTextContent('Projected rest of year: …');
  });
});

describe('dashboard calendar card', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(TODAY_NOON) }));
  afterEach(() => vi.useRealTimers());

  const EVENTS = [
    payment('aaa', '2026-10-20', 10.5),
    payment('aaa-ex', '2026-10-09', 0, { type: 'EX_DIVIDEND', countsAsIncome: false }),
    payment('bbb', '2026-10-20', 4.25, { status: 'ESTIMATED' }),
    payment('ccc', '2026-10-27', 5, { status: 'PAID' }),
    { ...payment('ddd', '2026-10-28', 0), type: 'EARNINGS', countsAsIncome: false, expectedAmount: undefined, earningsPhase: 'reported', description: 'Reported' } as CalendarEvent,
    payment('nov', '2026-11-10', 8),
  ];

  it('shows the month with coloured markers, the month total and a link to the full calendar', async () => {
    const urls = serveCalendar(EVENTS);
    renderWithProviders(<DashboardPage />);
    const calendar = await screen.findByTestId('dashboard-calendar');
    const grid = await within(calendar).findByTestId('compact-month-grid');

    const day20 = grid.querySelector('[data-date="2026-10-20"]')!;
    const markers = [...day20.querySelectorAll('[data-type]')].map((m) => [m.getAttribute('data-type'), m.getAttribute('data-status')]);
    expect(markers).toEqual([['DIVIDEND_PAY', 'CONFIRMED'], ['DIVIDEND_PAY', 'ESTIMATED']]);
    expect(day20.querySelector('[data-status="ESTIMATED"]')).toHaveClass('border-dashed');
    expect(day20.querySelector('[data-status="CONFIRMED"]')).toHaveClass('bg-[#dbeafe]');
    expect(grid.querySelector('[data-date="2026-10-09"] [data-type="EX_DIVIDEND"]')).toHaveClass('bg-[#e9d5ff]');
    expect(grid.querySelector('[data-date="2026-10-27"] [data-status="PAID"]')).toHaveClass('bg-[#dcfce7]');
    expect(grid.querySelector('[data-date="2026-10-28"] [data-type="EARNINGS"]')).toBeInTheDocument();
    expect(grid.querySelector('[data-date="2026-10-15"] [aria-current="date"]')).toHaveTextContent('15');
    expect(day20).toHaveTextContent(`${formatDate('2026-10-20')}: AAA, Dividend payment, confirmed, ${sp(formatMoney(10.5, 'EUR'))}; BBB, Dividend payment, estimated`);

    expect(calendar).toHaveTextContent(`Expected dividends in ${formatMonthYear('2026-10')}: ${sp(formatMoney(19.75, 'EUR'))}`);
    expect(within(calendar).getByRole('link', { name: 'Open full calendar →' })).toHaveAttribute('href', '/calendar?month=2026-10&scope=holdings');
    const first = urls.find((u) => u.searchParams.get('from') === monthGrid('2026-10').from)!;
    expect(first.searchParams.get('to')).toBe(monthGrid('2026-10').to);
    expect(first.searchParams.get('scope')).toBe('holdings');
  });

  it('moves between months and returns to today', async () => {
    const user = userEvent.setup();
    const urls = serveCalendar(EVENTS);
    renderWithProviders(<DashboardPage />);
    const calendar = await screen.findByTestId('dashboard-calendar');
    await within(calendar).findByTestId('compact-month-grid');

    await user.click(within(calendar).getByRole('button', { name: 'Next month' }));
    await waitFor(() => expect(calendar.querySelector('[data-date="2026-11-10"] [data-type]')).toBeInTheDocument());
    expect(urls.some((u) => u.searchParams.get('from') === monthGrid('2026-11').from)).toBe(true);
    expect(within(calendar).getByRole('link', { name: 'Open full calendar →' })).toHaveAttribute('href', '/calendar?month=2026-11&scope=holdings');
    expect(calendar.querySelector('[data-date="2026-10-20"]')).toBeNull();

    await user.click(within(calendar).getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(calendar.querySelector('[data-date="2026-10-20"] [data-type]')).toBeInTheDocument());
    await user.click(within(calendar).getByRole('button', { name: 'Previous month' }));
    await waitFor(() => expect(calendar.querySelector('[data-date="2026-09-15"]')).toBeInTheDocument());
  });

  it('collapses a crowded day into "+N"', async () => {
    serveCalendar(['a', 'b', 'c', 'd', 'e'].map((id) => payment(id, '2026-10-21', 1)));
    renderWithProviders(<DashboardPage />);
    const grid = await screen.findByTestId('compact-month-grid');
    const day = grid.querySelector('[data-date="2026-10-21"]')!;
    expect(day.querySelectorAll('[data-type]')).toHaveLength(3);
    expect(day).toHaveTextContent('+2');
  });

  it('reports a calendar that cannot be loaded and offers a retry', async () => {
    let failing = true;
    server.use(http.get(CALENDAR, () => (failing ? HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 }) : HttpResponse.json(calendarResponse([], '2026-09-28', '2026-11-01')))));
    const user = userEvent.setup();
    renderWithProviders(<DashboardPage />);
    const calendar = await screen.findByTestId('dashboard-calendar');
    expect(await within(calendar).findByText('Could not load the calendar')).toBeInTheDocument();
    failing = false;
    await user.click(within(calendar).getByRole('button', { name: /retry|try again/i }));
    expect(await within(calendar).findByTestId('compact-month-grid')).toBeInTheDocument();
  });
});
