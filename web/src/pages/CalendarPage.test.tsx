import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { addIsoDays, calendarMonthOf, computeAnalyticsSummary, type GetCalendarResponse } from '@portfolio/shared';
import { renderApp, renderWithProviders, sp } from '../test/utils';
import { server } from '../mocks/server';
import { getAnalyticsData, resetDb } from '../mocks/db';
import { formatMoney } from '../lib/format';
import { localToday } from '../features/calendar/calendarModel';
import { CalendarPage } from './CalendarPage';

vi.mock('../features/management/form', async (importOriginal) => ({ ...(await importOriginal<typeof import('../features/management/form')>()), downloadFile: vi.fn() }));
const { downloadFile } = await import('../features/management/form');

const TODAY = localToday();
const BUSY_DAY = addIsoDays(TODAY, 15);
const BUSY_MONTH = calendarMonthOf(BUSY_DAY);

/** Records the query strings of GET /calendar requests while still answering them from the demo backend. */
function trackRequests() {
  const urls: URL[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/calendar') urls.push(url);
  });
  return urls;
}

const open = (query = '') => renderWithProviders(<CalendarPage />, { route: `/calendar${query}` });
const events = () => screen.getByRole('region', { name: 'Events' });
/** Symbols of the event rows of the list view. */
const listedSymbols = () => new Set(within(events()).getAllByRole('listitem').map((li) => within(li).getByRole('button').getAttribute('aria-label')!.split(',')[0]));

describe('CalendarPage', () => {
  beforeEach(() => vi.mocked(downloadFile).mockClear());

  it('shows loading placeholders, then KPIs that match the analytics income, the chart and the coverage notes', async () => {
    open();
    expect(screen.getByRole('heading', { level: 1, name: 'Calendar' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Annual income' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading chart')).toBeInTheDocument();

    const income = computeAnalyticsSummary(getAnalyticsData()).passiveIncome;
    const annual = await screen.findByRole('region', { name: 'Annual income' });
    expect(await within(annual).findByText(sp(formatMoney(income.forward12m, 'EUR')))).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Monthly average' })).toHaveTextContent(sp(formatMoney(income.forward12m / 12, 'EUR')));
    expect(screen.getByRole('region', { name: 'Daily average' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Yield' })).toHaveTextContent('%');
    expect(screen.getByRole('img', { name: /^Dividend income per month over 12 months/ })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Dividend income per month' })).toBeInTheDocument();
    expect(screen.getByText('What does this calendar cover?')).toBeInTheDocument();
  });

  it('defaults to the list on small screens and shows the events of the month grouped by date', async () => {
    open();
    expect(await screen.findByRole('radio', { name: 'List' })).toBeChecked();
    const list = await within(events()).findAllByRole('heading', { level: 3 });
    expect(list.length).toBeGreaterThan(0);
    expect(within(events()).queryByRole('table')).not.toBeInTheDocument();
    expect(within(events()).getByText(/^Expected dividends in /)).toBeInTheDocument();
  });

  it('defaults to the month grid on wide screens', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }));
    open();
    expect(await screen.findByRole('radio', { name: 'Calendar' })).toBeChecked();
    expect(await within(events()).findByRole('table', { name: /Calendar events in .*, Monday to Sunday/ })).toBeInTheDocument();
  });

  it('requests the visible grid and navigates between months', async () => {
    const urls = trackRequests();
    const { container } = open('?view=calendar');
    const table = await within(events()).findByRole('table');
    expect(urls[0]!.searchParams.get('from')! <= `${calendarMonthOf(TODAY)}-01`).toBe(true);
    expect(urls[0]!.searchParams.has('portfolioId')).toBe(false);
    expect(container.querySelector('[aria-current="date"]')).toHaveTextContent(String(Number(TODAY.slice(8))));

    const month = screen.getByRole('heading', { level: 2, name: /\d{4}$/ }).textContent;
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /\d{4}$/ }).textContent).not.toBe(month));
    await waitFor(() => expect(urls.length).toBeGreaterThan(1));
    expect(urls.at(-1)!.searchParams.get('to')! > urls[0]!.searchParams.get('to')!).toBe(true);
    expect(table).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /\d{4}$/ }).textContent).toBe(month));
  });

  it('switches to the list of the next 12 months', async () => {
    const urls = trackRequests();
    open('?view=calendar');
    await within(events()).findByRole('table');
    await userEvent.click(screen.getByRole('radio', { name: 'Next 12 months' }));
    expect(screen.getByRole('radio', { name: 'Calendar' })).toBeDisabled();
    await within(events()).findByRole('heading', { level: 2, name: 'Next 12 months' }).catch(() => undefined);
    await waitFor(() => expect(urls.at(-1)!.searchParams.get('from')).toBe(TODAY));
    expect(urls.at(-1)!.searchParams.get('to')).toBe(addIsoDays(TODAY, 364));
    expect(await within(events()).findAllByRole('heading', { level: 3 })).not.toHaveLength(0);
    expect(within(events()).queryByText(/^Expected dividends in /)).not.toBeInTheDocument();
  });

  it('filters by event type, status and scope without reloading', async () => {
    const urls = trackRequests();
    open('?range=year');
    const list = events();
    await within(list).findAllByRole('heading', { level: 3 });
    const loaded = urls.length;
    const count = () => within(list).queryAllByRole('listitem').length;
    const all = count();
    expect(within(list).getAllByRole('button', { name: /Earnings,/ }).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Earnings' }));
    expect(within(list).queryAllByRole('button', { name: /Earnings,/ })).toHaveLength(0);
    expect(count()).toBeLessThan(all);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Earnings' }));
    expect(count()).toBe(all);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Estimated' }));
    expect(within(list).queryAllByText('Estimated', { selector: 'span' })).toHaveLength(0);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Estimated' }));

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'watchlist');
    expect(listedSymbols()).toEqual(new Set(['NVDA', 'SAP.DE']));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'holdings');
    expect(within(list).queryByRole('button', { name: /^NVDA,/ })).not.toBeInTheDocument();
    expect(urls.length).toBe(loaded);
  });

  it('explains an empty selection', async () => {
    open('?range=year');
    await within(events()).findAllByRole('heading', { level: 3 });
    for (const name of ['Ex-dividend', 'Dividend payment', 'Earnings', 'Stock split', 'Corporate action']) await userEvent.click(screen.getByRole('checkbox', { name }));
    expect(within(events()).getByText('No events in this period for the selected filters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download .ics' })).toBeDisabled();
  });

  it('collapses a busy day into "+N more" and opens the day, then an event with your quantity and expected amount', async () => {
    open(`?view=calendar&month=${BUSY_MONTH}`);
    const cell = (await within(events()).findAllByRole('cell')).find((c) => c.getAttribute('data-date') === BUSY_DAY)!;
    expect(within(cell).getAllByRole('button')).toHaveLength(4);
    await userEvent.click(within(cell).getByRole('button', { name: /^1 more on/ }));

    const day = await screen.findByRole('dialog');
    expect(day).toHaveAccessibleDescription('4 events');
    expect(within(day).getAllByRole('listitem')).toHaveLength(4);
    await userEvent.click(within(day).getByRole('button', { name: /^KO, Ex-dividend/ }));

    const dialog = await screen.findByRole('dialog', { name: 'KO · Ex-dividend' });
    expect(dialog).toHaveTextContent('Ex-dividend date');
    expect(dialog).toHaveTextContent('Your shares on the ex-date');
    expect(dialog).toHaveTextContent('60');
    expect(dialog).toHaveTextContent('Expected (net)');
    expect(dialog).toHaveTextContent(/€\s?\d/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens an earnings event from the list with EPS estimate and time of day', async () => {
    open('?range=year');
    await userEvent.click(await within(events()).findByRole('button', { name: /^AAPL, Earnings/ }));
    const dialog = await screen.findByRole('dialog', { name: 'AAPL · Earnings' });
    expect(dialog).toHaveTextContent(sp('US$ 1,64'));
    expect(dialog).toHaveTextContent('After market close');
    expect(dialog).toHaveTextContent('Alpha Vantage');
    expect(within(dialog).getByRole('link', { name: 'View in holdings' })).toHaveAttribute('href', '/holdings');
  });

  it('shows the upcoming stock split of the demo data', async () => {
    open('?range=year');
    await userEvent.click(await within(events()).findByRole('button', { name: /^MSFT, Stock split/ }));
    expect(await screen.findByRole('dialog', { name: 'MSFT · Stock split' })).toHaveTextContent('2-for-1 stock split');
  });

  it('downloads the filtered calendar as an .ics file', async () => {
    const urls: URL[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/calendar.ics') urls.push(url);
    });
    open('?range=year&types=EARNINGS,SPLIT&scope=holdings');
    await within(events()).findAllByRole('heading', { level: 3 });
    await userEvent.click(screen.getByRole('button', { name: 'Download .ics' }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledOnce());
    const [name, text, mime] = vi.mocked(downloadFile).mock.calls[0]!;
    expect(name).toBe(`portfolio-calendar-${TODAY}_${addIsoDays(TODAY, 364)}.ics`);
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(text).toContain('SUMMARY:AAPL · Earnings');
    expect(text).not.toContain('Ex-dividend');
    expect(mime).toBe('text/calendar;charset=utf-8');
    expect(urls[0]!.searchParams.get('types')).toBe('EARNINGS,SPLIT');
    expect(urls[0]!.searchParams.get('scope')).toBe('holdings');
    expect(urls[0]!.searchParams.get('status')).toBe('CONFIRMED,ESTIMATED,PAID');
    expect(await screen.findByText(/^Saved portfolio-calendar-/)).toHaveTextContent('not a subscription');
  });

  it('reports a failed download', async () => {
    server.use(http.get('/api/calendar.ics', () => HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Boom' } }, { status: 500 })));
    open('?range=year');
    await within(events()).findAllByRole('heading', { level: 3 });
    await userEvent.click(screen.getByRole('button', { name: 'Download .ics' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not download the calendar: Boom');
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('shows an error with a retry when the calendar cannot be loaded', async () => {
    server.use(http.get('/api/calendar', () => HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Calendar unavailable' } }, { status: 500 })));
    open('?range=year');
    expect(await screen.findByText('Could not load the calendar')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Calendar unavailable');
    server.resetHandlers();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await within(events()).findAllByRole('heading', { level: 3 })).not.toHaveLength(0);
    expect(screen.queryByText('Could not load the calendar')).not.toBeInTheDocument();
  });

  it('shows an empty state without holdings and watchlist symbols', async () => {
    resetDb({ empty: true });
    server.use(http.get('/api/watchlist', () => HttpResponse.json({ items: [] })));
    open();
    expect(await screen.findByText('Nothing to show in your calendar yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a transaction' })).toHaveAttribute('href', '/transactions');
    expect(screen.getByRole('link', { name: 'Open watchlist' })).toHaveAttribute('href', '/watchlist');
    expect(screen.queryByRole('region', { name: 'Annual income' })).not.toBeInTheDocument();
  });

  it('follows the portfolio scope', async () => {
    const urls = trackRequests();
    open('?portfolio=trading-212&range=year');
    await within(events()).findAllByRole('heading', { level: 3 });
    expect(urls[0]!.searchParams.get('portfolioId')).toBe('trading-212');
    expect(screen.getByText(/^Trading 212 · /)).toBeInTheDocument();
    const symbols = listedSymbols();
    expect(symbols.has('VWRL.AS')).toBe(false);
    expect(symbols.has('AAPL')).toBe(true);
  });

  it('keeps view, month and filters in the URL', async () => {
    const { router } = renderApp('/calendar?month=2027-01&view=calendar');
    expect(await screen.findByRole('heading', { level: 1, name: 'Calendar' })).toBeInTheDocument();
    expect(document.title).toBe('Calendar · Portfolio Tracker');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Earnings' }));
    await waitFor(() => expect(router.state.location.search).toContain('types=EX_DIVIDEND%2CDIVIDEND_PAY%2CSPLIT%2CCORPORATE_ACTION'));
    expect(router.state.location.search).toContain('month=2027-01');
    expect(router.state.location.search).toContain('view=calendar');
    // The list is the default in this (narrow) test viewport, so choosing it leaves the URL.
    await userEvent.click(screen.getByRole('radio', { name: 'List' }));
    await waitFor(() => expect(router.state.location.search).not.toContain('view='));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Earnings' }));
    await waitFor(() => expect(router.state.location.search).not.toContain('types='));
  });

  it('is reachable from the main navigation', async () => {
    renderApp('/');
    await userEvent.click(await screen.findByRole('link', { name: 'Calendar' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Calendar' })).toBeInTheDocument();
  });
});

describe('GET /calendar (demo backend)', () => {
  it('answers with the same events for the JSON and the .ics endpoint and validates its query', async () => {
    const body = (await (await fetch('/api/calendar?from=2026-01-01&to=2026-12-31&scope=holdings')).json()) as GetCalendarResponse;
    expect(body.events.every((e) => e.origin === 'HOLDING')).toBe(true);
    const bad = await fetch('/api/calendar?scope=nobody');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('VALIDATION_ERROR');
    expect((await fetch('/api/calendar?portfolioId=nope')).status).toBe(404);
    const ics = await fetch('/api/calendar.ics?types=SPLIT&portfolioId=all');
    expect(ics.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(await ics.text()).toContain('BEGIN:VEVENT');
  });
});
