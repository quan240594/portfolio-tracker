import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { KpiCard } from './KpiCard';
import { Change } from './Change';
import { DashboardPage } from '../pages/DashboardPage';
import { renderWithProviders } from '../test/utils';
import { server } from '../mocks/server';
import { resetDb, getPortfolio } from '../mocks/db';
import { formatMoney } from '../lib/format';

describe('KpiCard', () => {
  it('renders label, value, change and hint', () => {
    renderWithProviders(
      <KpiCard label="Day change" value="+€12.00" change={<Change pct={1.5} value={12} />} hint="since yesterday" />,
    );
    const card = screen.getByRole('region', { name: 'Day change' });
    expect(within(card).getByText('+€12.00')).toBeInTheDocument();
    expect(within(card).getByText('+1.50%')).toBeInTheDocument();
    expect(within(card).getByText('up')).toHaveClass('sr-only');
    expect(within(card).getByText('since yesterday')).toBeInTheDocument();
  });

  it('signals losses with a minus sign and "down" text, not only colour', () => {
    renderWithProviders(<KpiCard label="P&L" value="x" change={<Change pct={-2.25} value={-1} />} />);
    const card = screen.getByRole('region', { name: 'P&L' });
    expect(within(card).getByText('\u22122.25%')).toBeInTheDocument();
    expect(within(card).getByText('down')).toBeInTheDocument();
  });

  it('shows a skeleton while loading', () => {
    renderWithProviders(<KpiCard label="Total value" value="€1" loading />);
    const card = screen.getByRole('region', { name: 'Total value' });
    expect(card).toHaveAttribute('aria-busy', 'true');
    expect(within(card).queryByText('€1')).not.toBeInTheDocument();
  });
});

describe('Dashboard KPIs', () => {
  it('renders summary values from GET /portfolio', async () => {
    const summary = getPortfolio();
    renderWithProviders(<DashboardPage />);

    const total = await screen.findByRole('region', { name: 'Total value' });
    expect(await within(total).findByText(formatMoney(summary.totalValue, 'EUR'))).toBeInTheDocument();
    expect(within(total).getByText(new RegExp(`${summary.holdingsCount} holdings`))).toBeInTheDocument();

    const unrealized = screen.getByRole('region', { name: 'Unrealized P&L' });
    expect(within(unrealized).getByText(formatMoney(summary.unrealizedPnl, 'EUR', { signed: true }))).toBeInTheDocument();

    const totalReturn = screen.getByRole('region', { name: 'Total return' });
    expect(within(totalReturn).getByText(formatMoney(summary.totalReturn, 'EUR', { signed: true }))).toBeInTheDocument();

    const dividends = screen.getByRole('region', { name: 'Dividends received' });
    expect(within(dividends).getByText(formatMoney(summary.dividendsReceived, 'EUR'))).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Day change' })).toBeInTheDocument();
  });

  it('shows an error state with retry when the API fails', async () => {
    server.use(
      http.get('/api/portfolio', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'Database unavailable' } }, { status: 500 }),
      ),
    );
    renderWithProviders(<DashboardPage />);
    const alert = await screen.findByText('Database unavailable');
    expect(alert.closest('[role="alert"]')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
  });

  it('shows a call to action when there are no transactions', async () => {
    resetDb({ empty: true });
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByRole('heading', { name: 'No transactions yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add transaction' })).toHaveAttribute('href', '/transactions?action=add');
    expect(screen.getByRole('link', { name: 'Import CSV' })).toHaveAttribute('href', '/transactions?action=import');
  });
});
