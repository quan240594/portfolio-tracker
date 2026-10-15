import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { computeAssetDetail, type AssetDetailResponse } from '@portfolio/shared';
import { addTransaction, getSeed } from '../mocks/db';
import { ASSET_DETAILS } from '../mocks/assetDetails';
import { server } from '../mocks/server';
import { formatMoney } from '../lib/format';
import { mainNav, openPortfolioMenu, renderApp, sp } from '../test/utils';

const serverError = () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 });

/** Records the query of every request to a `/api/assets/*` endpoint ending in `suffix`. */
function recordRequests(suffix: string) {
  const seen: URLSearchParams[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/assets/') && url.pathname.endsWith(suffix)) seen.push(url.searchParams);
  });
  return seen;
}
afterEach(() => server.events.removeAllListeners());

async function openAsset(path: string) {
  const user = userEvent.setup();
  const app = renderApp(path);
  await screen.findByRole('heading', { level: 1 });
  return { user, ...app };
}

/** The detail the API would send for `symbol`, with `patch` applied (to exercise rarely seen states). */
function detailOf(symbol: string, patch: (d: AssetDetailResponse) => AssetDetailResponse = (d) => d): AssetDetailResponse {
  const seed = getSeed();
  const base = seed.profiles[symbol]!;
  const detail = computeAssetDetail({
    symbol,
    today: seed.today,
    profile: { ...base, ...ASSET_DETAILS[symbol] },
    quote: seed.quotes[symbol],
    eod: seed.eod[symbol] ?? [],
    dividendEvents: seed.dividendEvents.filter((e) => e.symbol === symbol),
    fx: seed.fx,
  })!;
  return patch(detail);
}

describe('header', () => {
  it('shows breadcrumb, price with day change, EUR equivalent and the key statistics', async () => {
    await openAsset('/assets/AAPL?portfolio=all');
    expect(screen.getByRole('heading', { level: 1, name: 'Apple Inc.' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Securities' })).toHaveAttribute('href', '/assets?portfolio=all');
    expect(crumbs).toHaveTextContent('United States');
    expect(crumbs).toHaveTextContent('Technology');
    expect(within(crumbs).getByText('AAPL')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('AAPL · NASDAQ · USD')).toBeInTheDocument();

    const quote = getSeed().quotes.AAPL!;
    expect(screen.getByTestId('asset-price')).toHaveTextContent(sp(formatMoney(quote.price, 'USD')));
    expect(screen.getByText(/today$/)).toBeInTheDocument();
    expect(screen.getByText(/^≈ € /)).toBeInTheDocument();

    const stats = within(screen.getByLabelText('Key statistics'));
    expect(stats.getByText('Next earnings').nextElementSibling).toHaveTextContent('—not available');
    expect(stats.getByText('P/E').nextElementSibling).toHaveTextContent('35,6');
    expect(stats.getByText('EPS').nextElementSibling).toHaveTextContent(sp('US$ 6,42'));
    expect(stats.getByText('Market cap').nextElementSibling).toHaveTextContent(sp('US$ 3,5 bln.'));
    expect(stats.getByText('Dividend yield').nextElementSibling).toHaveTextContent(/^\d,\d{2}%$/);
  });

  it('shows dashes, never invented values, for an ETF without earnings figures', async () => {
    await openAsset('/assets/VWRL.AS?portfolio=all');
    const stats = within(screen.getByLabelText('Key statistics'));
    for (const label of ['P/E', 'EPS', 'Market cap']) expect(stats.getByText(label).nextElementSibling).toHaveTextContent('—not available');
    const sidebar = within(screen.getByRole('complementary', { name: 'Key figures' }));
    expect(sidebar.getByText('Beta').nextElementSibling).toHaveTextContent('—not available');
    expect(sidebar.getByText('Dividend growth').nextElementSibling).toHaveTextContent('—not available');
  });

  it('does not repeat the euro price for a euro security', async () => {
    await openAsset('/assets/ASML.AS?portfolio=all');
    expect(screen.queryByText(/^≈ /)).not.toBeInTheDocument();
    expect(screen.getByText(/^As of /)).toBeInTheDocument();
  });

  it('warns when the price is outdated', async () => {
    server.use(http.get('/api/assets/KO', () => HttpResponse.json(detailOf('KO', (d) => ({ ...d, quote: { ...d.quote!, asOf: '2020-01-02T10:00:00.000Z' } })))));
    await openAsset('/assets/KO?portfolio=all');
    expect(await screen.findByText('price may be outdated')).toBeInTheDocument();
  });

  it('says so when there is no price yet', async () => {
    server.use(http.get('/api/assets/KO', () => HttpResponse.json(detailOf('KO', (d) => ({ ...d, quote: null })))));
    await openAsset('/assets/KO?portfolio=all');
    expect(screen.getByText('No price available yet.')).toBeInTheDocument();
  });

  it('labels a price derived from the last close', async () => {
    server.use(http.get('/api/assets/KO', () => HttpResponse.json(detailOf('KO', (d) => ({ ...d, quote: { ...d.quote!, source: 'eod' as const } })))));
    await openAsset('/assets/KO?portfolio=all');
    expect(screen.getByText(/ · Last close \d/)).toBeInTheDocument();
  });

  it('adds and removes the security on the watchlist', async () => {
    const { user } = await openAsset('/assets/AAPL?portfolio=all');
    const add = await screen.findByRole('button', { name: 'Add to watchlist' });
    expect(add).toHaveAttribute('aria-pressed', 'false');
    await user.click(add);
    const on = await screen.findByRole('button', { name: 'On your watchlist' });
    expect(on).toHaveAttribute('aria-pressed', 'true');
    await user.click(on);
    expect(await screen.findByRole('button', { name: 'Add to watchlist' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows a security that is already on the watchlist as such', async () => {
    await openAsset('/assets/NVDA?portfolio=all');
    expect(await screen.findByRole('button', { name: 'On your watchlist' })).toBeInTheDocument();
  });
});

describe('states', () => {
  it('shows a friendly page with a way back for an unknown symbol', async () => {
    renderApp('/assets/NOPE?portfolio=trading-212');
    expect(await screen.findByRole('heading', { name: 'We have no data for NOPE' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to assets' })).toHaveAttribute('href', '/assets?portfolio=trading-212');
  });

  it('treats a reserved symbol like an unknown one', async () => {
    renderApp('/assets/CASH.EUR');
    expect(await screen.findByRole('heading', { name: 'We have no data for CASH.EUR' })).toBeInTheDocument();
  });

  it('shows the public part for a symbol the user does not hold', async () => {
    await openAsset('/assets/NVDA?portfolio=all');
    expect(screen.getByRole('heading', { level: 1, name: 'NVIDIA Corporation' })).toBeInTheDocument();
    expect(await screen.findByText(/You have no position in NVDA/)).toBeInTheDocument();
    expect(await screen.findByTestId('asset-price-chart')).toBeInTheDocument();
  });

  it('reports a failed detail request and retries', async () => {
    let fail = true;
    server.use(http.get('/api/assets/AAPL', () => (fail ? serverError() : HttpResponse.json(detailOf('AAPL')))));
    const user = userEvent.setup();
    renderApp('/assets/AAPL');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this security');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Apple Inc.' })).toBeInTheDocument();
  });

  it('shows a loading region first', async () => {
    renderApp('/assets/AAPL');
    expect(await screen.findByRole('status')).toHaveTextContent('Loading security');
    await screen.findByRole('heading', { level: 1 });
  });

  it('reports failed history and positions requests inside their cards', async () => {
    server.use(http.get('/api/assets/AAPL/history', serverError), http.get('/api/assets/AAPL/positions', serverError));
    await openAsset('/assets/AAPL?portfolio=all');
    expect(await screen.findByText('Could not load the price history')).toBeInTheDocument();
    expect(await screen.findByText('Could not load your positions')).toBeInTheDocument();
  });

  it('says so when no prices are stored for the period', async () => {
    server.use(
      http.get('/api/assets/AAPL/history', () =>
        HttpResponse.json({ symbol: 'AAPL', range: '1Y', baseCurrency: 'EUR', currency: 'USD', points: [], benchmarks: [], options: [], markers: [], coverage: { from: null, to: null, limited: false } }),
      ),
    );
    await openAsset('/assets/AAPL?portfolio=all');
    expect(await screen.findByText('No price history is stored for AAPL in this period.')).toBeInTheDocument();
  });

  it('explains when the stored history is shorter than the selected range', async () => {
    const user = userEvent.setup();
    renderApp('/assets/AAPL?portfolio=all');
    await screen.findByTestId('asset-price-chart');
    await user.click(screen.getByRole('button', { name: '5Y' }));
    expect(await screen.findByText(/^Prices are stored from .*, so this period is shorter than selected\.$/)).toBeInTheDocument();
  });
});

describe('Overview tab', () => {
  it('shows the benchmarks bar, the chart, the key figures, positions and the company profile', async () => {
    await openAsset('/assets/ASML.AS?portfolio=all');
    expect(screen.getByRole('region', { name: 'Benchmarks' })).toBeInTheDocument();
    const chart = await screen.findByTestId('asset-price-chart');
    expect(chart).toHaveAccessibleName(/^Price change of ASML\.AS from .* to .*: [+−]?[\d,]+%\.$/);
    expect(screen.getByRole('list', { name: 'Trade markers' })).toBeInTheDocument();

    const sidebar = within(screen.getByRole('complementary', { name: 'Key figures' }));
    expect(sidebar.getByText('P/E ratio').nextElementSibling).toHaveTextContent('35,4');
    expect(sidebar.getByText('Beta').nextElementSibling).toHaveTextContent('1,35');
    expect(sidebar.getByText('Annual payout').nextElementSibling).toHaveTextContent(/^€ [\d,]+$/);
    expect(sidebar.getByText('Next ex-dividend date').nextElementSibling).toHaveTextContent(/\d{4}$/);
    expect(sidebar.getByText('Payout ratio').nextElementSibling).toHaveTextContent(/%$/);

    expect(await screen.findByRole('heading', { name: 'My positions' })).toBeInTheDocument();
    const about = screen.getByRole('region', { name: 'About ASML Holding N.V.' });
    expect(within(about).getByText('NL0010273215')).toBeInTheDocument();
    expect(within(about).getByText('Netherlands')).toBeInTheDocument();
    expect(within(about).getByText(/lithography machines/)).toBeInTheDocument();
  });

  it('says when a security has no description', async () => {
    await openAsset('/assets/BTC-EUR?portfolio=all');
    const about = screen.getByRole('region', { name: 'About Bitcoin' });
    expect(within(about).getByText('No description is available for this security from our data sources.')).toBeInTheDocument();
    expect(within(about).getByText('ISIN').nextElementSibling).toHaveTextContent('—not available');
  });

  it('requests the selected range and keeps the previous chart while loading', async () => {
    const seen = recordRequests('/history');
    const user = userEvent.setup();
    renderApp('/assets/ASML.AS?portfolio=all');
    await screen.findByTestId('asset-price-chart');
    const ranges = screen.getByRole('group', { name: 'Price history range' });
    expect(within(ranges).getAllByRole('button').map((b) => b.textContent)).toEqual(['7D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'All']);
    expect(within(ranges).getByRole('button', { name: '1Y' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(ranges).getByRole('button', { name: '3M' }));
    expect(within(ranges).getByRole('button', { name: '3M' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(seen.some((q) => q.get('range') === '3M')).toBe(true));
    expect(seen.every((q) => q.has('benchmarks'))).toBe(true);
    await user.click(within(ranges).getByRole('button', { name: 'All' }));
    await waitFor(() => expect(seen.some((q) => q.get('range') === 'ALL')).toBe(true));
    expect(await screen.findByTestId('asset-price-chart')).toBeInTheDocument();
  });

  it('switches between performance and price and describes each in words', async () => {
    const user = userEvent.setup();
    renderApp('/assets/ASML.AS?portfolio=all');
    const chart = await screen.findByTestId('asset-price-chart');
    expect(chart).toHaveAccessibleName(/^Price change of ASML\.AS/);
    const mode = screen.getByRole('radiogroup', { name: 'Chart type' });
    expect(within(mode).getByRole('radio', { name: 'Performance %' })).toBeChecked();
    await user.click(within(mode).getByRole('radio', { name: 'Price' }));
    expect(screen.getByTestId('asset-price-chart')).toHaveAccessibleName(/^Closing price of ASML\.AS/);
    expect(screen.getByText('Benchmarks are shown in the Performance % view, where all lines share one scale.')).toBeInTheDocument();
    await user.click(within(mode).getByRole('radio', { name: 'Performance %' }));
    expect(screen.queryByText(/Benchmarks are shown in the Performance/)).not.toBeInTheDocument();
  });

  it('offers a data table instead of the chart, and lists the trades in text', async () => {
    const user = userEvent.setup();
    renderApp('/assets/ASML.AS?portfolio=all');
    await screen.findByTestId('asset-price-chart');
    const toggle = screen.getByRole('button', { name: 'Data table' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const table = screen.getByRole('table', { name: 'ASML.AS price change over time' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Date', 'ASML.AS', 'IWDA.AS']);
    expect(screen.queryByTestId('asset-price-chart')).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByTestId('asset-price-chart')).toBeInTheDocument();

    await user.click(screen.getByText(/^Your transactions in this period/));
    const tradeTable = screen.getByRole('table', { name: 'Your transactions of this security in the selected period' });
    expect(within(tradeTable).getAllByRole('row').length).toBeGreaterThan(1);
    expect(within(tradeTable).getAllByText('Buy').length).toBeGreaterThan(0);
  });

  it('shows closing prices with their change in the table of the price view', async () => {
    const user = userEvent.setup();
    renderApp('/assets/ASML.AS?portfolio=all');
    await screen.findByTestId('asset-price-chart');
    await user.click(within(screen.getByRole('radiogroup', { name: 'Chart type' })).getByRole('radio', { name: 'Price' }));
    await user.click(screen.getByRole('button', { name: 'Data table' }));
    const table = screen.getByRole('table', { name: 'ASML.AS closing prices over time' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Date', 'Close', 'Change']);
  });

  it('adds and removes benchmarks, sends them with the request and notes the ones without prices', async () => {
    const seen = recordRequests('/history');
    const { user, router } = await openAsset('/assets/ASML.AS?portfolio=all');
    const bar = screen.getByRole('region', { name: 'Benchmarks' });
    expect(within(bar).getByText('IWDA.AS')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Select' }));
    await user.click(within(bar).getByRole('checkbox', { name: /VWRL\.AS/ }));
    expect(router.state.location.search).toContain('benchmarks=IWDA.AS%2CVWRL.AS');
    await waitFor(() => expect(seen.some((q) => q.get('benchmarks') === 'IWDA.AS,VWRL.AS')).toBe(true));

    await user.click(within(bar).getByRole('checkbox', { name: /EXSA\.DE/ }));
    expect(await screen.findByText(/No prices are tracked for EXSA\.DE, so it is left out\./)).toBeInTheDocument();

    await user.click(within(bar).getByRole('button', { name: 'Remove EXSA.DE' }));
    await user.click(within(bar).getByRole('button', { name: 'Remove VWRL.AS' }));
    await user.click(within(bar).getByRole('button', { name: 'Remove IWDA.AS' }));
    await waitFor(() => expect(seen.some((q) => q.get('benchmarks') === '')).toBe(true));
    expect(await screen.findByText(/None selected/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/No prices are tracked for/)).not.toBeInTheDocument());
  });
});

describe('My positions', () => {
  it('shows one card per portfolio with cost, profit, dividends and the share of the portfolio', async () => {
    await openAsset('/assets/AAPL?portfolio=trading-212');
    const section = screen.getByRole('region', { name: 'My positions' });
    const card = await within(section).findByRole('listitem', { name: 'Trading 212 position' });
    const text = sp(card.textContent ?? '');
    expect(text).toContain('Open');
    expect(text).toContain('Shares25');
    expect(text).toMatch(/Cost per share€ [\d,]+US\$ [\d,]+/);
    expect(text).toMatch(/Profit▲|Profit▼/);
    expect(text).toMatch(/Share of portfolio\d+,\d%/);
    expect(within(card).getByText('Dividends received').nextElementSibling).toHaveTextContent(/^€ /);
    expect(within(section).queryByRole('region', { name: 'Total across portfolios' })).not.toBeInTheDocument();
  });

  it('follows the portfolio scope: no position in another portfolio, one card per portfolio in the combined view', async () => {
    const { unmount } = await openAsset('/assets/AAPL?portfolio=default');
    expect(await screen.findByText('You have no position in AAPL in Main portfolio. Add a transaction on the Transactions page to track it here.')).toBeInTheDocument();
    unmount();

    addTransaction({ portfolioId: 'default', date: '2026-01-05', type: 'BUY', symbol: 'AAPL', quantity: 5, price: 200, fee: 0, currency: 'USD' });
    await openAsset('/assets/AAPL?portfolio=all');
    expect(await screen.findByRole('listitem', { name: 'Main portfolio position' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Trading 212 position' })).toBeInTheDocument();
    const totals = screen.getByRole('region', { name: 'Total across portfolios' });
    expect(within(totals).getByText('Shares').nextElementSibling).toHaveTextContent('30');
  });

  it('shows a sold-out position with its realised profit', async () => {
    addTransaction({ portfolioId: 'trading-212', date: '2026-09-01', type: 'SELL', symbol: 'KO', quantity: 60, price: 70, fee: 0, currency: 'USD' });
    await openAsset('/assets/KO?portfolio=trading-212');
    const card = await screen.findByRole('listitem', { name: 'Trading 212 position' });
    expect(within(card).getByText('Realised profit')).toBeInTheDocument();
    expect(within(card).queryByText('Shares')).not.toBeInTheDocument();
    expect(within(card).queryByText('Share of portfolio')).not.toBeInTheDocument();
    expect(within(card).getByText('Held from')).toBeInTheDocument();
    expect(within(card).getAllByText('Sold out')).toHaveLength(2);
  });

  it('refreshes when transactions change', async () => {
    const { queryClient } = await openAsset('/assets/NVDA?portfolio=trading-212');
    expect(await screen.findByText(/You have no position in NVDA/)).toBeInTheDocument();
    addTransaction({ portfolioId: 'trading-212', date: '2026-10-01', type: 'BUY', symbol: 'NVDA', quantity: 3, price: 130, fee: 0, currency: 'USD' });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['analytics', 'trading-212'] });
    });
    expect(await screen.findByRole('listitem', { name: 'Trading 212 position' })).toBeInTheDocument();
  });
});

describe('Dividends tab', () => {
  it('switches with the keyboard, keeps the tab in the URL and shows yield, chart, history and received dividends', async () => {
    const { user, router } = await openAsset('/assets/AAPL?portfolio=all');
    const tabs = screen.getByRole('tablist', { name: 'Security sections' });
    const overview = within(tabs).getByRole('tab', { name: 'Overview' });
    expect(overview).toHaveAttribute('aria-selected', 'true');
    overview.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(tabs).getByRole('tab', { name: 'Dividends' })).toHaveAttribute('aria-selected', 'true');
    expect(router.state.location.search).toContain('tab=dividends');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'asset-tab-dividends');

    const figures = within(screen.getByLabelText('Dividend figures'));
    expect(figures.getByText('Dividend yield').nextElementSibling).toHaveTextContent(/%$/);
    expect(figures.getByText('Annual payout per share').nextElementSibling).toHaveTextContent(/^US\$ /);
    expect(await screen.findByTestId('asset-dividend-chart')).toHaveAccessibleName(/^Dividend per share of AAPL per year: 20\d\d US\$\s/);

    const history = within(screen.getByRole('region', { name: 'Dividend history' }));
    expect(history.getByRole('table', { name: 'Dividend events of AAPL, newest first' })).toBeInTheDocument();
    const received = await screen.findByRole('table', { name: 'Dividends you received, newest first' });
    expect(within(received).getAllByRole('row').length).toBeGreaterThan(1);
    expect(figures.getByText('Received by you').nextElementSibling).toHaveTextContent(/^€ /);

    await user.click(screen.getByRole('button', { name: 'Data table' }));
    const byYear = screen.getByRole('table', { name: 'Dividend per share of AAPL per year' });
    expect(within(byYear).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Year', 'Per share', 'Payments', 'Coverage']);
    expect(within(byYear).getAllByText('Partial year').length).toBeGreaterThan(0);
  });

  it('opens on the Dividends tab from a deep link', async () => {
    await openAsset('/assets/AAPL?portfolio=all&tab=dividends');
    expect(screen.getByRole('tab', { name: 'Dividends' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('region', { name: 'Benchmarks' })).not.toBeInTheDocument();
  });

  it('ignores an unknown tab in the URL', async () => {
    await openAsset('/assets/AAPL?tab=nope');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('explains when a security pays no dividends and when nothing was received', async () => {
    await openAsset('/assets/BTC-EUR?portfolio=default&tab=dividends');
    expect(await screen.findByText('No dividends are stored for BTC-EUR.')).toBeInTheDocument();
    expect(screen.getByText(/No dividend events are stored for BTC-EUR\./)).toBeInTheDocument();
    expect(await screen.findByText('No dividends received for this security in the selected portfolios.')).toBeInTheDocument();
    expect(screen.getByLabelText('Dividend figures')).toHaveTextContent('Dividend yield—not available');
  });

  it('reports a failed positions request in the received card', async () => {
    server.use(http.get('/api/assets/AAPL/positions', serverError));
    await openAsset('/assets/AAPL?portfolio=all&tab=dividends');
    expect(await screen.findByText('Could not load your dividends')).toBeInTheDocument();
    expect(screen.getByLabelText('Dividend figures')).toHaveTextContent('Received by you—not available');
  });
});

describe('routing', () => {
  it('sets the document title from the decoded symbol', async () => {
    renderApp('/assets/BTC-EUR');
    await screen.findByRole('heading', { level: 1, name: 'Bitcoin' });
    expect(document.title).toBe('BTC-EUR · Asset detail · Portfolio Tracker');
  });

  it('keeps the nav on Assets', async () => {
    renderApp('/assets/AAPL');
    await screen.findByRole('heading', { level: 1, name: 'Apple Inc.' });
    const user = userEvent.setup();
    const trigger = await openPortfolioMenu(user);
    expect(trigger).toHaveAttribute('data-active', 'true');
    expect(within(mainNav()).getByRole('link', { name: 'Assets' })).toHaveAttribute('aria-current', 'page');
  });
});
