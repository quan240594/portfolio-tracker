import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { HoldingsPage } from './HoldingsPage';
import { renderWithProviders } from '../test/utils';
import { server } from '../mocks/server';
import { getHoldings, resetDb } from '../mocks/db';
import { formatMoney } from '../lib/format';

describe('HoldingsPage', () => {
  it('shows a loading region, then a summary and the table', async () => {
    const { holdings } = getHoldings();
    const total = holdings.reduce((s, h) => s + h.marketValue, 0);
    renderWithProviders(<HoldingsPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading holdings');

    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('rowheader')).toHaveLength(holdings.length);
    expect(
      screen.getByText(`${holdings.length} positions · ${formatMoney(total, 'EUR')} · prices in trading currency, values in EUR`),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows an error state and recovers on retry', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/holdings', () => HttpResponse.error(), { once: true }));
    renderWithProviders(<HoldingsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load holdings');
    expect(alert).toHaveTextContent('Could not reach the server. Check your connection and try again.');

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an empty state with a link to add a transaction', async () => {
    resetDb({ empty: true });
    renderWithProviders(<HoldingsPage />);
    expect(await screen.findByRole('heading', { name: 'No open positions' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add transaction' })).toHaveAttribute('href', '/transactions?action=add');
    expect(screen.getByText(/^0 positions/)).toBeInTheDocument();
  });
});
