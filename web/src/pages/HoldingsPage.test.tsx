import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { HoldingsPage } from './HoldingsPage';
import { renderWithProviders, sp } from '../test/utils';
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
      screen.getByText(sp(`${holdings.length} positions · ${formatMoney(total, 'EUR')} · all amounts in EUR`)),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows EUR-first prices and realistic currency effects from the mock FX history', async () => {
    const { holdings } = getHoldings();
    const usd = holdings.filter((h) => h.currency === 'USD');
    expect(usd.length).toBeGreaterThan(0);
    // The euro strengthened from ~1.04 to ~1.17 USD over the year → USD holdings lost value in EUR.
    for (const h of usd) {
      expect(h.currencyEffect).toBeLessThan(0);
      expect(h.priceBase).toBeLessThan(h.priceLocal);
    }
    for (const h of holdings.filter((x) => x.currency === 'EUR')) expect(h.currencyEffect).toBe(0);

    renderWithProviders(<HoldingsPage />);
    const table = await screen.findByRole('table');
    const aapl = holdings.find((h) => h.symbol === 'AAPL')!;
    const cells = within(within(table).getByRole('rowheader', { name: /AAPL/ }).closest('tr')!).getAllByRole('cell');
    expect(cells[2]).toHaveTextContent(sp(`${formatMoney(aapl.priceBase, 'EUR')}${formatMoney(aapl.priceLocal, 'USD')}`));
    expect(cells[6]).toHaveTextContent(sp(formatMoney(aapl.currencyEffect, 'EUR', { signed: true })));
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
