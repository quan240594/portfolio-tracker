import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import {
  buildBenchmarkOptions,
  computeGrowth,
  computeHoldingsPerformance,
  type AnalyticsGrowthResponse,
  type AnalyticsHoldingsPerformanceResponse,
  type GrowthRange,
} from '@portfolio/shared';
import { getAnalyticsData } from '../../mocks/db';
import { server } from '../../mocks/server';
import { formatMoney } from '../../lib/format';
import { renderApp, sp } from '../../test/utils';
import { BENCHMARKS_STORAGE_KEY } from './benchmarkSelection';

const growthUrl = '/api/analytics/growth';
const holdingsUrl = '/api/analytics/holdings-performance';
const serverError = () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 });

const options = () =>
  buildBenchmarkOptions(
    Object.keys(getAnalyticsData().eod).map((symbol) => ({ symbol, hasData: true, ...(getAnalyticsData().profiles[symbol] ? { name: getAnalyticsData().profiles[symbol]!.name } : {}) })),
  );
const growth = (range: GrowthRange = '1Y', benchmarks: string[] = ['IWDA.AS']): AnalyticsGrowthResponse => computeGrowth(getAnalyticsData(), range, benchmarks, options());
const holdings = (range: GrowthRange = '1Y'): AnalyticsHoldingsPerformanceResponse => computeHoldingsPerformance(getAnalyticsData(), range);

/** Records `<path>?<query>` of every analytics growth request. */
function recordRequests() {
  const seen: URLSearchParams[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname === growthUrl || url.pathname === holdingsUrl) seen.push(url.searchParams);
  });
  return seen;
}
afterEach(() => server.events.removeAllListeners());

const card = (name: string) => screen.getByRole('region', { name });

describe('Growth tab', () => {
  it('is the default tab and shows the five cards with the benchmark headline', async () => {
    renderApp('/analytics');
    expect(await screen.findByRole('region', { name: 'Benchmarks' })).toBeInTheDocument();
    expect(screen.getByText('Loading portfolio value')).toBeInTheDocument();
    const chart = await screen.findByTestId('growth-value-chart');
    expect(chart).toHaveAccessibleName(/^Portfolio value from .* to .*, compared with IWDA\.AS replayed with the same cash flows\.$/);
    const headline = await screen.findByText(/^Your portfolio is (ahead of|behind) IWDA\.AS by /);
    expect(sp(headline.textContent!)).toMatch(/by € [\d.]+,\d{2} \([\d,]+ percentage points\) since \d{2}-\d{2}-\d{4}\.$/);
    for (const name of ['Portfolio value', 'Portfolio performance', 'Dynamics of portfolio returns', 'Holdings performance']) expect(card(name)).toBeInTheDocument();
    expect(await screen.findByTestId('growth-performance-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('growth-dynamics-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('growth-holdings-chart')).toBeInTheDocument();
    // legend: start → end value of the portfolio, the benchmark and the invested amount
    const value = card('Portfolio value');
    const p = growth().period!;
    expect(within(value).getByText(sp(`${formatMoney(p.startValue)} → ${formatMoney(p.endValue)}`))).toBeInTheDocument();
    expect(within(value).getByText(sp(formatMoney(p.invested)))).toBeInTheDocument();
    // every card explains its method
    for (const name of ['Portfolio value', 'Portfolio performance', 'Dynamics of portfolio returns', 'Holdings performance']) {
      expect(within(card(name)).getByText(/How is this calculated\?|About these returns/)).toBeInTheDocument();
    }
  });

  it('switches the range of the value card without touching the others', async () => {
    const seen = recordRequests();
    renderApp('/analytics');
    await screen.findByTestId('growth-value-chart');
    const user = userEvent.setup();
    const value = card('Portfolio value');
    const ranges = within(within(value).getByRole('group', { name: 'Portfolio value range' })).getAllByRole('button');
    expect(ranges.map((b) => b.textContent)).toEqual(['7D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'All']);
    expect(within(value).getByRole('button', { name: '1Y' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(value).getByRole('button', { name: '3M' }));
    expect(within(value).getByRole('button', { name: '3M' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(value).getByRole('button', { name: '1Y' })).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(seen.some((q) => q.get('range') === '3M')).toBe(true));
    expect(within(card('Portfolio performance')).getByRole('button', { name: '1Y' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(card('Portfolio performance')).getByRole('button', { name: 'All' }));
    await waitFor(() => expect(seen.some((q) => q.get('range') === 'ALL')).toBe(true));
    await user.click(within(card('Holdings performance')).getByRole('button', { name: 'YTD' }));
    await waitFor(() => expect(seen.some((q) => q.get('range') === 'YTD' && !q.has('benchmarks'))).toBe(true));
    expect(seen.every((q) => !q.has('portfolioId'))).toBe(true);
  });

  it('keeps previous data visible and always sends the benchmarks list', async () => {
    const seen = recordRequests();
    renderApp('/analytics?portfolio=trading-212');
    await screen.findByTestId('growth-value-chart');
    const growthRequests = seen.filter((q) => q.has('benchmarks'));
    expect(growthRequests.every((q) => q.get('benchmarks') === 'IWDA.AS' && q.get('portfolioId') === 'trading-212')).toBe(true);
  });

  it('shows the value and the return as data tables on request', async () => {
    renderApp('/analytics');
    await screen.findByTestId('growth-value-chart');
    const user = userEvent.setup();
    const toggle = within(card('Portfolio value')).getByRole('button', { name: 'Data table' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    const table = within(card('Portfolio value')).getByRole('table', { name: 'Portfolio value over time' });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Date', 'Portfolio', 'Invested', 'IWDA.AS']);
    expect(within(table).getAllByRole('row').length).toBe(25);
    expect(screen.queryByTestId('growth-value-chart')).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByTestId('growth-value-chart')).toBeInTheDocument();

    await user.click(within(card('Portfolio performance')).getByRole('button', { name: 'Data table' }));
    const perf = within(card('Portfolio performance')).getByRole('table', { name: 'Cumulative return over time' });
    expect(within(perf).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Date', 'Portfolio', 'IWDA.AS']);
    expect(within(perf).getAllByRole('row')[1]).toHaveTextContent('0,00%');
  });

  it('removes the benchmark lines from the performance and dynamics cards when Compare is off', async () => {
    renderApp('/analytics');
    await screen.findByTestId('growth-performance-chart');
    const user = userEvent.setup();
    const perf = card('Portfolio performance');
    expect(within(perf).getByText('IWDA.AS')).toBeInTheDocument();
    const toggles = screen.getAllByRole('checkbox', { name: 'Compare' });
    expect(toggles).toHaveLength(2);
    expect(toggles.every((t) => (t as HTMLInputElement).checked)).toBe(true);
    await user.click(toggles[0]!);
    expect(toggles.every((t) => !(t as HTMLInputElement).checked)).toBe(true);
    expect(within(perf).queryByText('IWDA.AS')).not.toBeInTheDocument();
    expect(within(card('Dynamics of portfolio returns')).queryByText('IWDA.AS')).not.toBeInTheDocument();
    // the value card always shows the benchmark replay
    expect(within(card('Portfolio value')).getByText('IWDA.AS')).toBeInTheDocument();
  });

  it('shows monthly dynamics for the last 12 months or a calendar year, with a details table', async () => {
    renderApp('/analytics');
    const dynamics = await screen.findByRole('region', { name: 'Dynamics of portfolio returns' });
    await within(dynamics).findByTestId('growth-dynamics-chart');
    const user = userEvent.setup();
    const years = growth().monthly.map((m) => m.month.slice(0, 4));
    const periods = within(within(dynamics).getByRole('radiogroup', { name: 'Dynamics period' })).getAllByRole('radio');
    expect(periods.map((p) => p.textContent)).toEqual(['Last 12 months', ...new Set(years)]);

    const details = within(dynamics).getByRole('button', { name: 'View details' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    await user.click(details);
    const table = within(dynamics).getByRole('table', { name: 'Monthly returns, newest first' });
    expect(within(table).getAllByRole('row')).toHaveLength(13);
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Month', 'Portfolio', 'IWDA.AS']);
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent(/[▲▼■]/);
    expect(within(dynamics).getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');

    const lastYear = [...new Set(years)].at(-1)!;
    await user.click(within(dynamics).getByRole('radio', { name: lastYear }));
    const expected = growth().monthly.filter((m) => m.month.startsWith(lastYear)).length;
    expect(within(within(dynamics).getByRole('table')).getAllByRole('row')).toHaveLength(expected + 1);
    await user.click(within(dynamics).getByRole('button', { name: 'Hide details' }));
    expect(within(dynamics).queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows the holdings as bars sorted best first, switches to a table and changes the range', async () => {
    const seen = recordRequests();
    renderApp('/analytics');
    const card5 = await screen.findByRole('region', { name: 'Holdings performance' });
    const chart = await within(card5).findByTestId('growth-holdings-chart');
    const list = holdings().holdings;
    expect(chart.getAttribute('aria-label')).toContain(`Best ${list[0]!.symbol}`);
    expect(chart.getAttribute('aria-label')).toContain(`worst ${list.at(-1)!.symbol}`);
    const user = userEvent.setup();
    await user.click(within(card5).getByRole('radio', { name: 'Table' }));
    const table = within(card5).getByRole('table', { name: 'Return per holding, best first' });
    const symbols = within(table).getAllByRole('rowheader').map((r) => r.textContent);
    expect(symbols).toEqual(list.map((h) => h.symbol));
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Symbol', 'Name', 'Return', 'Return (€)', 'Measured from']);
    expect(screen.queryByTestId('growth-holdings-chart')).not.toBeInTheDocument();
    await user.click(within(card5).getByRole('radio', { name: 'Bars' }));
    expect(await within(card5).findByTestId('growth-holdings-chart')).toBeInTheDocument();
    await user.click(within(card5).getByRole('button', { name: '1M' }));
    await waitFor(() => expect(seen.some((q) => q.get('range') === '1M' && !q.has('benchmarks'))).toBe(true));
    expect(holdings('1M').holdings.length).toBeGreaterThan(0);
  });

  it('marks holdings that were bought inside the range', async () => {
    const data = holdings();
    server.use(http.get(holdingsUrl, () => HttpResponse.json({ ...data, holdings: data.holdings.map((h, i) => ({ ...h, sincePurchase: i === 0, from: i === 0 ? '2026-03-02' : data.from })) })));
    renderApp('/analytics');
    const card5 = await screen.findByRole('region', { name: 'Holdings performance' });
    await userEvent.setup().click(await within(card5).findByRole('radio', { name: 'Table' }));
    const first = within(card5).getAllByRole('row')[1]!;
    expect(first).toHaveTextContent('02-03-2026 *');
    expect(within(card5).getByText(/bought inside the range is measured from its first purchase/)).toBeInTheDocument();
  });
});

describe('Benchmarks bar', () => {
  it('adds and removes benchmarks, keeps them in the URL and the session, and limits them to three', async () => {
    const seen = recordRequests();
    const { router } = renderApp('/analytics');
    const bar = await screen.findByRole('region', { name: 'Benchmarks' });
    await screen.findByTestId('growth-value-chart');
    const user = userEvent.setup();
    expect(within(within(bar).getByRole('list', { name: 'Selected benchmarks' })).getAllByRole('listitem')).toHaveLength(1);

    const select = within(bar).getByRole('button', { name: 'Select' });
    expect(select).toHaveAttribute('aria-expanded', 'false');
    await user.click(select);
    expect(select).toHaveAttribute('aria-expanded', 'true');
    const list = within(bar).getByRole('group', { name: 'Benchmarks' });
    expect(select).toHaveAttribute('aria-controls', list.parentElement!.id);
    expect(within(list).getByRole('checkbox', { name: /IWDA\.AS/ })).toBeChecked();
    expect(within(list).getAllByRole('group').map((g) => within(g).getByText(/^(With|Suggestions).*price data$/).textContent)).toEqual(['With price data', 'Suggestions and watchlist without price data']);

    await user.click(within(list).getByRole('checkbox', { name: /VWRL\.AS/ }));
    expect(router.state.location.search).toBe('?benchmarks=IWDA.AS%2CVWRL.AS');
    expect(sessionStorage.getItem(BENCHMARKS_STORAGE_KEY)).toBe('IWDA.AS,VWRL.AS');
    await waitFor(() => expect(seen.some((q) => q.get('benchmarks') === 'IWDA.AS,VWRL.AS')).toBe(true));
    expect(await within(card('Portfolio value')).findByText('VWRL.AS')).toBeInTheDocument();

    await user.click(within(list).getByRole('checkbox', { name: /AAPL/ }));
    expect(sessionStorage.getItem(BENCHMARKS_STORAGE_KEY)).toBe('IWDA.AS,VWRL.AS,AAPL');
    expect(within(bar).getByText('You can compare with at most 3 benchmarks.')).toBeInTheDocument();
    const blocked = within(list).getByRole('checkbox', { name: /ASML\.AS/ });
    expect(blocked).toBeDisabled();
    await user.click(blocked);
    expect(sessionStorage.getItem(BENCHMARKS_STORAGE_KEY)).toBe('IWDA.AS,VWRL.AS,AAPL');

    await user.click(within(list).getByRole('checkbox', { name: /AAPL/ }));
    await user.click(within(bar).getByRole('button', { name: 'Remove VWRL.AS' }));
    expect(sessionStorage.getItem(BENCHMARKS_STORAGE_KEY)).toBe('IWDA.AS');
    await user.click(within(bar).getByRole('button', { name: 'Remove IWDA.AS' }));
    expect(router.state.location.search).toBe('?benchmarks=');
    expect(within(bar).getByText(/None selected/)).toBeInTheDocument();
    expect(await screen.findByText('Select a benchmark above to compare your portfolio with.')).toBeInTheDocument();
    expect(seen.some((q) => q.get('benchmarks') === '')).toBe(true);
  });

  it('tabs through the options and closes with Escape or an outside click', async () => {
    renderApp('/analytics');
    const bar = await screen.findByRole('region', { name: 'Benchmarks' });
    const user = userEvent.setup();
    const select = within(bar).getByRole('button', { name: 'Select' });
    await user.click(select);
    const options = within(bar).getAllByRole('checkbox');
    options[0]!.focus();
    await user.keyboard('{Tab}');
    expect(options[1]).toHaveFocus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(options[0]).toHaveFocus();
    const before = (options[0] as HTMLInputElement).checked;
    await user.keyboard('{ }');
    expect((options[0] as HTMLInputElement).checked).toBe(!before);
    await user.keyboard('{Escape}');
    expect(within(bar).queryByRole('group', { name: 'Benchmarks' })).not.toBeInTheDocument();
    expect(select).toHaveFocus();

    await user.keyboard('{Escape}');
    await user.click(select);
    await user.click(document.body);
    expect(within(bar).queryByRole('group', { name: 'Benchmarks' })).not.toBeInTheDocument();
    await user.click(select);
    await user.click(select);
    expect(within(bar).queryByRole('group', { name: 'Benchmarks' })).not.toBeInTheDocument();
  });

  it('restores the selection of this session and ignores an invalid URL value', async () => {
    sessionStorage.setItem(BENCHMARKS_STORAGE_KEY, 'VWRL.AS');
    const first = renderApp('/analytics');
    const bar = await screen.findByRole('region', { name: 'Benchmarks' });
    expect(within(bar).getByText('VWRL.AS')).toBeInTheDocument();
    first.unmount();
    renderApp('/analytics?benchmarks=IWDA.AS,nope!');
    const again = await screen.findByRole('region', { name: 'Benchmarks' });
    expect(within(again).getByText('VWRL.AS')).toBeInTheDocument();
  });

  it('survives unavailable storage', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    renderApp('/analytics');
    const bar = await screen.findByRole('region', { name: 'Benchmarks' });
    expect(within(bar).getByText('IWDA.AS')).toBeInTheDocument();
    await userEvent.setup().click(within(bar).getByRole('button', { name: 'Remove IWDA.AS' }));
    expect(within(bar).getByText(/None selected/)).toBeInTheDocument();
    get.mockRestore();
    set.mockRestore();
  });

  it('explains how to add a benchmark that has no price data, without failing the page', async () => {
    renderApp('/analytics?benchmarks=VWCE.DE,IWDA.AS');
    const bar = await screen.findByRole('region', { name: 'Benchmarks' });
    expect(await within(bar).findByText('no data')).toBeInTheDocument();
    expect(within(bar).getByText(/No price history is tracked for VWCE\.DE, so it is left out of the comparison\. To add it, put the symbol on your/)).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: 'Watchlist' })).toHaveAttribute('href', '/watchlist');
    // the page still works: the portfolio and the other benchmark are drawn
    expect(await screen.findByTestId('growth-value-chart')).toBeInTheDocument();
    expect(sp(screen.getByText(/^Your portfolio is (ahead of|behind) IWDA\.AS by /).textContent!)).toContain('IWDA.AS');
    const user = userEvent.setup();
    await user.click(within(bar).getByRole('button', { name: 'Select' }));
    expect(within(bar).getByRole('checkbox', { name: /VWCE\.DE/ }).closest('label')).toHaveTextContent('no price data yet');
  });

  it('uses plural wording when several benchmarks have no data', async () => {
    renderApp('/analytics?benchmarks=VWCE.DE,SXR8.DE');
    const bar = await screen.findByRole('region', { name: 'Benchmarks' });
    expect(await within(bar).findByText(/No price history is tracked for VWCE\.DE, SXR8\.DE, so they are left out of the comparison\. To add them,/)).toBeInTheDocument();
    expect(await screen.findByText('No benchmark comparison is available for this period.')).toBeInTheDocument();
  });

  it('offers the suggestions until the options arrive', async () => {
    server.use(http.get(growthUrl, async () => new Promise(() => undefined)));
    renderApp('/analytics');
    const bar = await screen.findByRole('region', { name: 'Benchmarks' });
    await userEvent.setup().click(within(bar).getByRole('button', { name: 'Select' }));
    expect(within(bar).getAllByRole('checkbox').map((o) => o.closest('label')!.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('IWDA.AS · iShares Core MSCI World'), expect.stringContaining('SXR8.DE · iShares Core S&P 500')]),
    );
  });
});

describe('Growth tab states', () => {
  it('shows errors per card with a retry', async () => {
    let fail = true;
    server.use(http.get(growthUrl, () => (fail ? serverError() : HttpResponse.json(growth()))), http.get(holdingsUrl, () => (fail ? serverError() : HttpResponse.json(holdings()))));
    renderApp('/analytics');
    await screen.findAllByRole('alert');
    expect(within(card('Portfolio value')).getByRole('alert')).toHaveTextContent('Could not load the portfolio value');
    expect(within(card('Portfolio performance')).getByRole('alert')).toHaveTextContent('Could not load the portfolio performance');
    expect(within(card('Dynamics of portfolio returns')).getByRole('alert')).toHaveTextContent('Could not load the monthly returns');
    expect(await within(card('Holdings performance')).findByRole('alert')).toHaveTextContent('Could not load the holdings performance');
    fail = false;
    await userEvent.setup().click(within(card('Holdings performance')).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('growth-holdings-chart')).toBeInTheDocument();
    await userEvent.setup().click(within(card('Portfolio value')).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('growth-value-chart')).toBeInTheDocument();
  });

  it('shows empty states without transactions', async () => {
    const empty = computeGrowth({ ...getAnalyticsData(), transactions: [] }, '1Y', ['IWDA.AS'], options());
    server.use(
      http.get(growthUrl, () => HttpResponse.json(empty)),
      http.get(holdingsUrl, () => HttpResponse.json(computeHoldingsPerformance({ ...getAnalyticsData(), transactions: [] }, '1Y'))),
    );
    renderApp('/analytics');
    expect(await within(await screen.findByRole('region', { name: 'Portfolio value' })).findByText('Add transactions to see how your portfolio grows.')).toBeInTheDocument();
    expect(await within(card('Portfolio performance')).findByText('Add transactions to see how your portfolio grows.')).toBeInTheDocument();
    expect(await within(card('Dynamics of portfolio returns')).findByText('Not enough history yet to show monthly returns.')).toBeInTheDocument();
    expect(await within(card('Holdings performance')).findByText('No open positions with a return in this range yet.')).toBeInTheDocument();
  });

  it('says so when nothing can be compared yet', async () => {
    const data = growth();
    server.use(http.get(growthUrl, () => HttpResponse.json({ ...data, headline: null })));
    renderApp('/analytics');
    expect(await screen.findByText('No benchmark comparison is available for this period.')).toBeInTheDocument();
  });

  it('describes a headline that is behind the benchmark', async () => {
    const data = growth();
    server.use(http.get(growthUrl, () => HttpResponse.json({ ...data, headline: { ...data.headline!, amount: -250, differencePct: -2 } })));
    renderApp('/analytics');
    expect(sp((await screen.findByText(/^Your portfolio is behind IWDA\.AS by /)).textContent!)).toMatch(/^Your portfolio is behind IWDA\.AS by € 250,00 \(2 percentage points\) since /);
  });

  it('waits for an unknown portfolio before querying', async () => {
    const seen = recordRequests();
    renderApp('/analytics?portfolio=does-not-exist');
    await screen.findByTestId('growth-value-chart');
    expect(seen.every((q) => q.get('portfolioId') === null)).toBe(true);
    await act(async () => undefined);
  });
});
