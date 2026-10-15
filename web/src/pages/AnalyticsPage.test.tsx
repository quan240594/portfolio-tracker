import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { AnalyticsBenchmarkResponse, AnalyticsDividendGrowthResponse, AnalyticsReturnsResponse, AnalyticsRiskResponse } from '@portfolio/shared';
import { computeBenchmark, computeDividendGrowth, computeReturns, computeRisk } from '@portfolio/shared';
import { renderApp } from '../test/utils';
import { server } from '../mocks/server';
import { getAnalyticsData } from '../mocks/db';

const api = (path: string) => `/api/analytics${path}`;
const serverError = () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 });

const returns = (period: 'year' | 'quarter' | 'month'): AnalyticsReturnsResponse => computeReturns(getAnalyticsData(), period);
const risk = (): AnalyticsRiskResponse => computeRisk(getAnalyticsData(), 'IWDA.AS');
const benchmark = (): AnalyticsBenchmarkResponse => computeBenchmark(getAnalyticsData(), 'IWDA.AS', '1Y');
const growth = (): AnalyticsDividendGrowthResponse => computeDividendGrowth(getAnalyticsData());

async function openTab(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name }));
  return user;
}

describe('AnalyticsPage', () => {
  it('is reachable from the nav and shows accessible tabs with the growth tab first', async () => {
    renderApp('/analytics');
    expect(await screen.findByRole('heading', { level: 1, name: 'Analytics' })).toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Analytics' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Growth', 'Returns', 'Risk', 'Benchmark', 'Dividend growth', 'Income goal']);
    expect(within(tabs).getByRole('tab', { name: 'Growth' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('link', { name: 'Analytics' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Growth');
  });

  it('falls back to the growth tab for an unknown ?tab= value and honours a valid one', async () => {
    const first = renderApp('/analytics?tab=nope');
    expect(await screen.findByRole('tab', { name: 'Growth', selected: true })).toBeInTheDocument();
    first.unmount();
    renderApp('/analytics?tab=returns');
    expect(await screen.findByRole('tab', { name: 'Returns', selected: true })).toBeInTheDocument();
  });

  it('shows the returns table per year and switches to quarters and months', async () => {
    renderApp('/analytics?tab=returns');
    expect(screen.getByText('Loading returns')).toBeInTheDocument();
    const yearTable = await screen.findByRole('table', { name: 'Returns per year, newest first' });
    expect(within(yearTable).getByRole('columnheader', { name: 'IRR' })).toBeInTheDocument();
    const rows = returns('year').rows;
    expect(within(yearTable).getAllByRole('row')).toHaveLength(Math.min(rows.length, 10) + 1);
    expect(within(yearTable).getAllByRole('rowheader')[0]).toHaveTextContent(rows.at(-1)!.period);

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Quarter' }));
    const quarters = await screen.findByRole('table', { name: 'Returns per quarter, newest first' });
    expect(within(quarters).queryByRole('columnheader', { name: 'IRR' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Month' }));
    expect(await screen.findByRole('table', { name: 'Returns per month, newest first' })).toBeInTheDocument();
  });

  it('shows an empty message when there is not enough history for returns', async () => {
    server.use(http.get(api('/returns'), () => HttpResponse.json({ ...returns('year'), rows: [] })));
    renderApp('/analytics?tab=returns');
    expect(await screen.findByText('Not enough history yet to calculate returns.')).toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    let fail = true;
    server.use(http.get(api('/returns'), () => (fail ? serverError() : HttpResponse.json(returns('year')))));
    renderApp('/analytics?tab=returns');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load returns');
    fail = false;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: /Returns per year/ })).toBeInTheDocument();
  });

  it('shows the risk metrics and changes the benchmark', async () => {
    renderApp('/analytics?tab=risk');
    const table = await screen.findByRole('table', { name: 'Risk metrics' });
    expect(within(table).getByRole('rowheader', { name: 'Volatility (annualised)' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Beta vs IWDA.AS' })).toBeInTheDocument();
    expect(screen.getByText(/weekday returns from/)).toBeInTheDocument();

    const requested: (string | null)[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === api('/risk')) requested.push(url.searchParams.get('benchmark'));
    });
    await userEvent.setup().click(screen.getByRole('radio', { name: 'VWRL.AS' }));
    expect(await screen.findByRole('rowheader', { name: 'Beta vs VWRL.AS' })).toBeInTheDocument();
    expect(requested).toEqual(['VWRL.AS']);
    server.events.removeAllListeners();
  });

  it('explains missing history and benchmark data in the risk tab', async () => {
    const base = risk();
    server.use(
      http.get(api('/risk'), () =>
        HttpResponse.json({
          ...base,
          observations: 5,
          volatilityPct: null,
          sharpe: null,
          sortino: null,
          maxDrawdown: { depthPct: -10, peakDate: '2026-01-02', troughDate: '2026-02-02', recoveryDate: null },
          benchmark: { ...base.benchmark, available: false, beta: null, correlation: null, message: 'No price history for IWDA.AS' },
        } satisfies AnalyticsRiskResponse),
      ),
    );
    renderApp('/analytics?tab=risk');
    expect(await screen.findByText(/need at least 20 trading days/)).toBeInTheDocument();
    expect(screen.getByText('No price history for IWDA.AS')).toBeInTheDocument();
    expect(screen.getByText(/not yet recovered/)).toBeInTheDocument();
  });

  it('describes a drawdown that recovered, and the absence of one', async () => {
    const base = risk();
    const handler = (maxDrawdown: AnalyticsRiskResponse['maxDrawdown']) =>
      server.use(http.get(api('/risk'), () => HttpResponse.json({ ...base, maxDrawdown })));
    handler({ depthPct: -5, peakDate: '2026-01-02', troughDate: '2026-02-02', recoveryDate: '2026-03-02' });
    const first = renderApp('/analytics?tab=risk');
    expect(await screen.findByText(/recovered/)).toBeInTheDocument();
    first.unmount();

    handler(null);
    renderApp('/analytics?tab=risk');
    expect(await screen.findByText('No decline since you started.')).toBeInTheDocument();
  });

  it('shows the benchmark comparison and lets the range change', async () => {
    renderApp('/analytics?tab=benchmark');
    expect(await screen.findByText('Your return (TWR)')).toBeInTheDocument();
    expect(screen.getByText('Difference')).toBeInTheDocument();
    const ranges: (string | null)[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === api('/benchmark')) ranges.push(url.searchParams.get('range'));
    });
    const user = await openTab('Benchmark');
    await user.click(screen.getByRole('radio', { name: '3M' }));
    await waitFor(() => expect(ranges).toContain('3M'));
    await user.click(screen.getByRole('radio', { name: 'VWRL.AS' }));
    await waitFor(() => expect(ranges.length).toBeGreaterThan(1));
    server.events.removeAllListeners();
  });

  it('reports an unavailable benchmark without failing', async () => {
    const base = benchmark();
    server.use(
      http.get(api('/benchmark'), () =>
        HttpResponse.json({ ...base, benchmark: { symbol: 'IWDA.AS', available: false, message: 'No end-of-day data for IWDA.AS yet' }, comparison: null } satisfies AnalyticsBenchmarkResponse),
      ),
    );
    renderApp('/analytics?tab=benchmark');
    expect(await screen.findByText('No end-of-day data for IWDA.AS yet')).toBeInTheDocument();
    expect(screen.queryByText('Your return (TWR)')).not.toBeInTheDocument();
  });

  it('shows an empty benchmark window with and without a message', async () => {
    const base = benchmark();
    server.use(http.get(api('/benchmark'), () => HttpResponse.json({ ...base, points: [], comparison: null, benchmark: { ...base.benchmark, message: undefined } })));
    renderApp('/analytics?tab=benchmark');
    expect(await screen.findByText('No history for this period yet.')).toBeInTheDocument();
  });

  it('shows dividend growth per year, month and share', async () => {
    renderApp('/analytics?tab=dividends');
    expect(await screen.findByRole('table', { name: 'Dividends per year' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Dividend per share by year' })).toBeInTheDocument();
    expect(screen.getByTestId('dividend-year-chart')).toBeInTheDocument();
    expect(screen.getByTestId('dividend-month-chart')).toBeInTheDocument();
  });

  it('shows an empty state when no dividends were received', async () => {
    server.use(http.get(api('/dividend-growth'), () => HttpResponse.json({ ...growth(), byYear: [], byMonth: [], perShare: [] })));
    renderApp('/analytics?tab=dividends');
    expect(await screen.findByText(/No dividends received yet/)).toBeInTheDocument();
  });

  it('marks the current year as year to date', async () => {
    const base = growth();
    server.use(
      http.get(api('/dividend-growth'), () =>
        HttpResponse.json({
          ...base,
          byYear: base.byYear.map((y, i, all) => ({ ...y, partial: i === all.length - 1 })),
          perShare: base.perShare.map((s) => ({ ...s, years: s.years.map((y, i, all) => ({ ...y, partial: i === all.length - 1 })) })),
        }),
      ),
    );
    renderApp('/analytics?tab=dividends');
    expect(await screen.findByText('year to date')).toBeInTheDocument();
  });

  it('projects the income goal and validates the form', async () => {
    renderApp('/analytics?tab=goal');
    const table = await screen.findByRole('table', { name: 'Projection per scenario' });
    expect(within(table).getAllByRole('rowheader').map((r) => r.textContent)).toEqual(['Cautious', 'Base', 'Optimistic']);

    const user = userEvent.setup();
    const target = screen.getByLabelText('Target annual income (€)');
    await user.clear(target);
    await user.type(target, 'abc');
    await user.click(screen.getByRole('button', { name: 'Update projection' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(target).toHaveAttribute('aria-invalid', 'true');

    const requested: URLSearchParams[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === api('/goal')) requested.push(url.searchParams);
    });
    await user.clear(target);
    await user.type(target, '5000');
    await user.click(screen.getByRole('checkbox', { name: 'Reinvest dividends' }));
    await user.click(screen.getByRole('button', { name: 'Update projection' }));
    await waitFor(() => expect(requested.at(-1)?.get('targetIncome')).toBe('5000'));
    expect(requested.at(-1)?.get('reinvestDividends')).toBe('false');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    server.events.removeAllListeners();
  });

  it('explains goals that are reached already or not within the horizon', async () => {
    const user = userEvent.setup();
    renderApp('/analytics?tab=goal');
    await screen.findByRole('table', { name: 'Projection per scenario' });
    const target = screen.getByLabelText('Target annual income (€)');
    await user.clear(target);
    await user.type(target, '1');
    await user.click(screen.getByRole('button', { name: 'Update projection' }));
    expect(await screen.findAllByText('Already reached')).not.toHaveLength(0);

    await user.clear(target);
    await user.type(target, '900000000');
    await user.click(screen.getByRole('button', { name: 'Update projection' }));
    expect((await screen.findAllByText(/Not within \d+ years/)).length).toBeGreaterThan(0);
  });

  it('renders years to goal in the base scenario', async () => {
    renderApp('/analytics?tab=goal');
    const table = await screen.findByRole('table', { name: 'Projection per scenario' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });

  it('keeps the tab in the URL', async () => {
    const { router } = renderApp('/analytics');
    await screen.findByRole('tab', { name: 'Growth', selected: true });
    await openTab('Returns');
    expect(router.state.location.search).toContain('tab=returns');
    await screen.findByRole('table', { name: /Returns per year/ });
    await openTab('Risk');
    expect(router.state.location.search).toContain('tab=risk');
    expect(await screen.findByRole('table', { name: 'Risk metrics' })).toBeInTheDocument();
  });
});
