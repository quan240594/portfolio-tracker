import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { DashboardPage } from './DashboardPage';
import { renderWithProviders } from '../test/utils';
import { server } from '../mocks/server';
import { getHistory, getHoldings, getPortfolio } from '../mocks/db';
import { formatDate } from '../lib/format';

const serverError = (message: string) =>
  HttpResponse.json({ error: { code: 'INTERNAL', message } }, { status: 500 });

const chartFor = (range: Parameters<typeof getHistory>[0]) => {
  const { points } = getHistory(range);
  return new RegExp(`^Portfolio value from ${formatDate(points[0]!.date)} to ${formatDate(points.at(-1)!.date)}`);
};

afterEach(() => server.events.removeAllListeners());

describe('DashboardPage', () => {
  it('shows loading placeholders, then KPIs, chart, allocation and top holdings', async () => {
    renderWithProviders(<DashboardPage />);
    expect(screen.getByRole('region', { name: 'Total value' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading chart')).toBeInTheDocument();
    expect(screen.getByText('Loading allocation')).toBeInTheDocument();
    expect(screen.getByText('Loading holdings')).toBeInTheDocument();

    expect(await screen.findByRole('img', { name: chartFor('1Y') })).toBeInTheDocument();
    expect(screen.getByText(/^All portfolios · values in EUR · as of/)).toBeInTheDocument();
    expect(screen.getByText(/P&L change over period:/)).toBeInTheDocument();
    expect(screen.getByText(/Total return [+\u2212]?[\d.,]+% on amount invested/)).toBeInTheDocument();

    const panel = await screen.findByRole('tabpanel', { name: 'Asset class' });
    expect(within(panel).getAllByRole('listitem').length).toBeGreaterThan(0);

    const top = screen.getByRole('region', { name: 'Top holdings' });
    const items = await within(top).findAllByRole('listitem');
    expect(items).toHaveLength(5);
    const expected = getHoldings().holdings.slice(0, 5);
    expect(items.map((li) => li.querySelector('.font-semibold')?.textContent?.trim())).toEqual(
      expected.map((h) => (h.priceStale ? `${h.symbol} Stale price` : h.symbol)),
    );
    expect(within(top).getByRole('link', { name: 'View all →' })).toHaveAttribute('href', '/holdings');
  });

  it('switches the chart range and requests the matching history', async () => {
    const user = userEvent.setup();
    const ranges: (string | null)[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/history') ranges.push(url.searchParams.get('range'));
    });
    renderWithProviders(<DashboardPage />);
    await screen.findByRole('img', { name: chartFor('1Y') });

    const group = screen.getByRole('radiogroup', { name: 'Chart range' });
    expect(within(group).getByRole('radio', { name: '1Y' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(group).getByRole('radio', { name: '1M' }));
    expect(within(group).getByRole('radio', { name: '1M' })).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByRole('img', { name: chartFor('1M') })).toBeInTheDocument();

    await user.click(within(group).getByRole('radio', { name: 'ALL' }));
    expect(await screen.findByRole('img', { name: chartFor('ALL') })).toBeInTheDocument();
    expect(ranges).toEqual(['1Y', '1M', 'ALL']);
  });

  it('switches allocation tabs', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DashboardPage />);
    const tabs = screen.getByRole('tablist', { name: 'Allocation by' });
    await screen.findByRole('tabpanel', { name: 'Asset class' });

    await user.click(within(tabs).getByRole('tab', { name: 'Currency' }));
    expect(within(tabs).getByRole('tab', { name: 'Currency' })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel', { name: 'Currency' });
    expect(await within(panel).findByText('USD')).toBeInTheDocument();
    expect(within(panel).getByText('EUR')).toBeInTheDocument();

    await user.click(within(tabs).getByRole('tab', { name: 'Sector' }));
    expect(await within(screen.getByRole('tabpanel', { name: 'Sector' })).findByText('Technology')).toBeInTheDocument();

    await user.click(within(tabs).getByRole('tab', { name: 'Country' }));
    expect(await within(screen.getByRole('tabpanel', { name: 'Country' })).findByText('United States')).toBeInTheDocument();
  });

  it('shows per-card errors and recovers on retry', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/portfolio', () => serverError('Summary down'), { once: true }),
      http.get('/api/history', () => serverError('History down'), { once: true }),
      http.get('/api/allocation', () => serverError('Allocation down'), { once: true }),
      http.get('/api/holdings', () => serverError('Holdings down'), { once: true }),
    );
    renderWithProviders(<DashboardPage />);

    for (const [title, message] of [
      ['Could not load portfolio summary', 'Summary down'],
      ['Could not load history', 'History down'],
      ['Could not load allocation', 'Allocation down'],
      ['Could not load holdings', 'Holdings down'],
    ] as const) {
      const alert = (await screen.findByText(title)).closest('[role="alert"]') as HTMLElement;
      expect(alert).toHaveTextContent(message);
    }

    for (const button of screen.getAllByRole('button', { name: 'Try again' })) await user.click(button);

    expect(await screen.findByRole('region', { name: 'Total value' })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: chartFor('1Y') })).toBeInTheDocument();
    expect(await screen.findByRole('tabpanel', { name: 'Asset class' })).not.toHaveTextContent('Could not load');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(within(screen.getByRole('region', { name: 'Top holdings' })).getAllByRole('listitem')).toHaveLength(5);
  });

  it('handles empty history and allocation', async () => {
    server.use(
      http.get('/api/history', () => HttpResponse.json({ range: '1Y', baseCurrency: 'EUR', points: [] })),
      http.get('/api/allocation', () => HttpResponse.json({ by: 'assetClass', baseCurrency: 'EUR', slices: [] })),
    );
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('No history for this period yet.')).toBeInTheDocument();
    expect(await screen.findByText('Nothing to allocate yet.')).toBeInTheDocument();
    expect(screen.queryByText(/P&L change over period/)).not.toBeInTheDocument();
  });

  it('keeps the dashboard (not the empty state) when everything was sold but returns exist', async () => {
    server.use(http.get('/api/portfolio', () => HttpResponse.json({ ...getPortfolio(), holdingsCount: 0, totalReturn: 42 })));
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText(/0 holdings · cost/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No transactions yet' })).not.toBeInTheDocument();
  });
});
