import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { computeMetrics } from '@portfolio/shared';
import { renderApp } from '../../test/utils';
import { server } from '../../mocks/server';
import { getAnalyticsData } from '../../mocks/db';
import { metricsFixture } from './testData';

const api = '/api/analytics/metrics';
const serverError = () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 });

function recordRequests() {
  const requests: URLSearchParams[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname === api) requests.push(url.searchParams);
  });
  return requests;
}

afterEach(() => server.events.removeAllListeners());

describe('Metrics tab (demo backend)', () => {
  it('shows all five cards with realistic numbers from the demo data', async () => {
    renderApp('/analytics?tab=metrics');
    const expected = computeMetrics(getAnalyticsData(), 'IWDA.AS');

    expect(await screen.findByRole('heading', { name: 'Portfolio TWR' })).toBeInTheDocument();
    for (const name of ['Portfolio P/E', 'Volatility / beta', 'Risk-adjusted return / Sharpe ratio', 'Risk-adjusted return / Sortino ratio']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getByTestId('twr-value').textContent).toMatch(/^[+\u2212]\d+,\d%$/);
    expect(expected.pe.portfolio).not.toBeNull();
    expect(screen.getByTestId('pe-value').textContent).toMatch(/^\d+,\d×$/);
    // The demo has five stocks, one without earnings data, so coverage is meaningful.
    expect(screen.getByTestId('pe-coverage').textContent).toMatch(/^Based on 4 of 5 stocks, \d+% of portfolio value\.$/);
    expect(screen.getAllByRole('meter')).toHaveLength(4);
    expect(screen.getByTestId('metric-volatility').textContent).toMatch(/β = \d,\d{3}/);
    expect(screen.getByTestId('metric-sharpe').textContent).toMatch(/Sharpe ratio = [\u2212]?\d,\d{3} — /);
    expect(screen.getByTestId('metric-sortino').textContent).toMatch(/Sortino ratio = [\u2212]?\d,\d{3} — /);
  });

  it('shows a loading region until the metrics arrive', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(api, async () => {
        await gate;
        return HttpResponse.json(metricsFixture());
      }),
    );
    renderApp('/analytics?tab=metrics');
    expect(await screen.findByText('Loading metrics')).toBeInTheDocument();
    release();
    expect(await screen.findByRole('heading', { name: 'Portfolio TWR' })).toBeInTheDocument();
    expect(screen.queryByText('Loading metrics')).not.toBeInTheDocument();
  });

  it('shows the error with a retry and recovers', async () => {
    let fail = true;
    server.use(http.get(api, () => (fail ? serverError() : HttpResponse.json(metricsFixture()))));
    renderApp('/analytics?tab=metrics');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load metrics');
    fail = false;
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Portfolio TWR' })).toBeInTheDocument();
  });

  it('switches the benchmark and asks the API for it', async () => {
    renderApp('/analytics?tab=metrics');
    await screen.findByRole('heading', { name: 'Portfolio TWR' });
    expect(screen.getAllByText(/Market = IWDA\.AS/).length).toBeGreaterThan(0);
    const requests = recordRequests();
    await userEvent.setup().click(screen.getByRole('radio', { name: 'VWRL.AS' }));
    await waitFor(() => expect(requests.map((r) => r.get('benchmark'))).toContain('VWRL.AS'));
    expect((await screen.findAllByText(/Market = VWRL\.AS/)).length).toBeGreaterThan(0);
    expect(screen.getByTestId('metric-twr')).toHaveTextContent('VWRL.AS:');
  });

  it('follows the portfolio scope', async () => {
    const requests = recordRequests();
    renderApp('/analytics?tab=metrics&portfolio=trading-212');
    await screen.findByRole('heading', { name: 'Portfolio TWR' });
    expect(requests.at(-1)?.get('portfolioId')).toBe('trading-212');
    // Trading 212 holds four US stocks, one without earnings data.
    expect(screen.getByTestId('pe-coverage')).toHaveTextContent('Based on 3 of 4 stocks');
  });

  it('explains a benchmark without data once and keeps the portfolio figures', async () => {
    const data = metricsFixture({
      benchmark: { symbol: 'IWDA.AS', available: false, message: 'No end-of-day prices are tracked for IWDA.AS.' },
      twr: { ...metricsFixture().twr, benchmark: null, difference: null, benchmarkFrom: null },
      volatility: { ...metricsFixture().volatility, benchmark: null, beta: null, verdict: null },
    });
    server.use(http.get(api, () => HttpResponse.json(data)));
    renderApp('/analytics?tab=metrics');
    expect(await screen.findByText('No end-of-day prices are tracked for IWDA.AS.')).toBeInTheDocument();
    expect(screen.getByTestId('twr-value')).toBeInTheDocument();
    expect(screen.getByText('Benchmark comparison unavailable.')).toBeInTheDocument();
  });

  it('shows an empty message for a portfolio without transactions', async () => {
    const data = metricsFixture({
      benchmark: { symbol: 'IWDA.AS', available: false, message: 'Add transactions to compare your portfolio with a benchmark.' },
      twr: { portfolio: null, benchmark: null, difference: null, from: null, to: '2026-10-15', days: 0, benchmarkFrom: null },
    });
    server.use(http.get(api, () => HttpResponse.json(data)));
    renderApp('/analytics?tab=metrics');
    expect(await screen.findByText('Add transactions to compare your portfolio with a benchmark.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Portfolio TWR' })).not.toBeInTheDocument();
  });

  it('falls back to a generic empty message', async () => {
    const data = metricsFixture({ benchmark: { symbol: 'IWDA.AS', available: true }, twr: { ...metricsFixture().twr, from: null, portfolio: null } });
    server.use(http.get(api, () => HttpResponse.json(data)));
    renderApp('/analytics?tab=metrics');
    expect(await screen.findByText('Add transactions to see your portfolio metrics.')).toBeInTheDocument();
  });

  it('rejects an invalid benchmark with a validation error', async () => {
    const res = await fetch(`${api}?benchmark=no%20good`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    const missing = await fetch(`${api}?portfolioId=does-not-exist`);
    expect(missing.status).toBe(404);
  });
});
