import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { computeDividendsOverview, type GetDividendsResponse } from '@portfolio/shared';
import { DividendsPage } from './DividendsPage';
import { renderApp, renderWithProviders, sp } from '../test/utils';
import { server } from '../mocks/server';
import { getAnalyticsData, getDividends } from '../mocks/db';
import { formatDate, formatMoney } from '../lib/format';

const overview = (over: Partial<GetDividendsResponse> = {}): GetDividendsResponse => ({ ...getDividends(), ...over });
const REGIONS = [
  'Yield',
  'Dividends',
  'Yield / payout',
  'Passive income diversification',
  'Dividend safety',
  'Average annual growth',
  'Future payments',
  'Dividends received',
  'Dividends received by holding',
  'Dividend growth',
];

afterEach(() => server.events.removeAllListeners());

describe('DividendsPage', () => {
  it('shows every card of the dashboard once the data has loaded', async () => {
    const data = computeDividendsOverview(getAnalyticsData());
    renderWithProviders(<DividendsPage />);
    expect(screen.getByRole('region', { name: 'Yield' })).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByTestId('kpi-income')).toHaveTextContent(sp(formatMoney(data.summary.forward12m, 'EUR')));
    for (const name of REGIONS) expect(screen.getByRole('region', { name })).toBeInTheDocument();
    expect(await screen.findByTestId('yield-payout-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('income-donut')).toBeInTheDocument();
    expect(await screen.findByTestId('consistency-donut')).toBeInTheDocument();
    expect(await screen.findByTestId('growth-cagr-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('future-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('received-time-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('received-holding-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('year-compare-chart')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lists the upcoming and received payments in the payment history', async () => {
    const data = getDividends();
    renderWithProviders(<DividendsPage />);

    const upcoming = await within(await screen.findByRole('region', { name: 'Upcoming' })).findAllByRole('listitem');
    expect(upcoming).toHaveLength(data.upcoming.length);
    const first = data.upcoming[0]!;
    expect(upcoming[0]).toHaveTextContent(first.symbol);
    expect(upcoming[0]).toHaveTextContent(`pays ${formatDate(first.date)}`);
    expect(upcoming[0]).toHaveTextContent(sp(formatMoney(first.amount, 'EUR')));
    expect(upcoming[0]).toHaveTextContent(sp(`${formatMoney(first.perShareLocal, first.currency, { maxDigits: 4 })} per share`));

    const table = within(screen.getByRole('region', { name: 'Received' })).getByRole('table', { name: 'Received dividends, newest first' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(data.received.length);
    const newest = data.received.at(-1)!;
    expect(rows[0]).toHaveTextContent(formatDate(newest.date));
    expect(rows[0]).toHaveTextContent(newest.symbol);
    expect(rows[0]).toHaveTextContent(sp(formatMoney(newest.amount, 'EUR')));

    // Per-share amounts stay in the paying currency; amounts are converted to EUR.
    expect(within(table).getByRole('columnheader', { name: 'Amount (EUR)' })).toBeInTheDocument();
    const reversed = [...data.received].reverse();
    const usd = reversed.findIndex((p) => p.currency === 'USD');
    const usdCells = within(rows[usd]!).getAllByRole('cell');
    expect(usdCells[2]).toHaveTextContent(sp(formatMoney(reversed[usd]!.perShareLocal, 'USD', { maxDigits: 4 })));
    expect(usdCells[2]).toHaveTextContent(/^US\$/);
    expect(usdCells[3]).toHaveTextContent(new RegExp(`^${sp(formatMoney(reversed[usd]!.amount, 'EUR'))}$`));
  });

  it('collapses the payment history', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DividendsPage />);
    const table = await screen.findByRole('table', { name: 'Received dividends, newest first' });
    expect(table).toBeVisible();
    await user.click(screen.getByText('Payment history'));
    expect(table).not.toBeVisible();
    await user.click(screen.getByText('Payment history'));
    expect(table).toBeVisible();
  });

  it('shows errors per card and retries', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/dividends', () => new HttpResponse('upstream exploded', { status: 503, statusText: 'Service Unavailable' }), { once: true }));
    renderWithProviders(<DividendsPage />);
    const alerts = await screen.findAllByRole('alert');
    // received over time, received by holding and the payment history all read GET /dividends
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toHaveTextContent('Could not load dividends');
    expect(alerts[0]).toHaveTextContent('Service Unavailable');
    // the other cards have their own data and are not affected
    expect(await screen.findByTestId('kpi-income')).toBeInTheDocument();

    await user.click(within(alerts[0]!).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Received dividends, newest first' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the empty state instead of the dashboard when there are no dividends at all', async () => {
    server.use(http.get('/api/dividends', () => HttpResponse.json(overview({ received: [], upcoming: [], monthly: [], totalReceived: 0, last12Months: 0, projectedNext12Months: 0 }))));
    renderWithProviders(<DividendsPage />);
    expect(await screen.findByRole('heading', { name: 'No dividends yet' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Yield' })).not.toBeInTheDocument();
  });

  it('handles no upcoming and no received dividends separately', async () => {
    server.use(http.get('/api/dividends', () => HttpResponse.json(overview({ upcoming: [] })), { once: true }));
    const { unmount } = renderWithProviders(<DividendsPage />);
    expect(await screen.findByText('No announced dividends for your current holdings.')).toBeInTheDocument();
    unmount();

    server.use(http.get('/api/dividends', () => HttpResponse.json(overview({ received: [] }))));
    renderWithProviders(<DividendsPage />);
    const history = await screen.findByRole('region', { name: 'Received' });
    expect(await within(history).findByText('No dividends received yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Received dividends, newest first' })).not.toBeInTheDocument();
  });

  it('queries every card for the selected portfolio, or for all portfolios', async () => {
    const seen: { path: string; portfolioId: string | null }[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (/dividends|analytics/.test(url.pathname)) seen.push({ path: url.pathname, portfolioId: url.searchParams.get('portfolioId') });
    });
    const first = renderApp('/dividends?portfolio=trading-212');
    expect(await screen.findByText(/^Trading 212 · amounts in EUR/)).toBeInTheDocument();
    expect(await screen.findByTestId('year-compare-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('future-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('received-time-chart')).toBeInTheDocument();
    for (const path of ['/api/dividends/overview', '/api/dividends', '/api/analytics/dividend-growth']) {
      expect(seen.some((s) => s.path === path)).toBe(true);
      expect(seen.filter((s) => s.path === path).every((s) => s.portfolioId === 'trading-212')).toBe(true);
    }
    first.unmount();

    seen.length = 0;
    renderApp('/dividends?portfolio=all');
    expect(await screen.findByTestId('year-compare-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('future-chart')).toBeInTheDocument();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.portfolioId === null)).toBe(true);
  });

  it('is reachable from the router', async () => {
    renderApp('/dividends');
    expect(await screen.findByRole('heading', { level: 1, name: 'Dividends' })).toBeInTheDocument();
    expect(
      screen.getByText('All portfolios · amounts in EUR (per-share amounts in the paying currency). Received amounts are net of withholding tax; forward income is declared plus estimated.'),
    ).toBeInTheDocument();
  });
});

const cardOrder = () => [...document.querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset.cardId);

describe('DividendsPage layout', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the default card order and puts the customize toggle in the page header', async () => {
    renderApp('/dividends');
    expect(await screen.findByRole('heading', { name: 'Payment history' })).toBeInTheDocument();
    expect(cardOrder()).toEqual([
      'kpis',
      'yield-payout',
      'diversification',
      'consistency',
      'received-over-time',
      'received-by-holding',
      'future-payments',
      'average-growth',
      'dividend-growth',
      'payment-history',
    ]);
    const actions = document.querySelector('[data-page-header-actions]')!;
    expect(within(actions as HTMLElement).getByRole('button', { name: 'Customize layout' })).toBeInTheDocument();
  });

  it('reorders and hides cards', async () => {
    const user = userEvent.setup();
    renderApp('/dividends');
    await screen.findByRole('heading', { name: 'Payment history' });
    await user.click(screen.getByRole('button', { name: 'Customize layout' }));
    await user.click(screen.getByRole('button', { name: 'Move Dividends received by holding down' }));
    expect(cardOrder().slice(4, 7)).toEqual(['received-over-time', 'future-payments', 'received-by-holding']);

    await user.click(screen.getByRole('button', { name: 'Hide Dividend growth' }));
    expect(cardOrder()).not.toContain('dividend-growth');
    await user.click(screen.getByRole('button', { name: 'Show Dividend growth' }));
    expect(cardOrder()).toContain('dividend-growth');
  });

  it('keeps the period selector driving the by-holding card wherever the cards are, and when the selector card is hidden', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-27T10:00:00Z') });
    const template = getDividends().received[0]!;
    const received = [
      { ...template, symbol: 'OLDCO', date: '2020-03-10', amount: 10 },
      { ...template, symbol: 'NEWCO', date: '2026-09-15', amount: 20 },
    ];
    server.use(http.get('/api/dividends', () => HttpResponse.json(overview({ received }))));
    const user = userEvent.setup();
    renderWithProviders(<DividendsPage />);
    const holdingCard = await screen.findByRole('region', { name: 'Dividends received by holding' });
    const holdings = async () => {
      const table = await within(holdingCard).findByRole('table', { name: 'Dividends received per holding' });
      return within(table).getAllByRole('rowheader').map((c) => c.textContent);
    };
    await user.click(await within(holdingCard).findByText('Show data table'));
    expect(await holdings()).toEqual(['NEWCO', 'OLDCO']);

    await user.click(screen.getByRole('radio', { name: '12 months' }));
    expect(await holdings()).toEqual(['NEWCO']);

    await user.click(screen.getByRole('button', { name: 'Customize layout' }));
    await user.click(screen.getByRole('button', { name: 'Hide Dividends received' }));
    expect(screen.queryByRole('radio', { name: '12 months' })).not.toBeInTheDocument();
    expect(await holdings()).toEqual(['NEWCO']);
  });
});
