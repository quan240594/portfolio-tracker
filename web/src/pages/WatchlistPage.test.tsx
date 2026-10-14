import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderApp } from '../test/utils';
import { server } from '../mocks/server';

describe('WatchlistPage', () => {
  it('lists watched symbols with price and day change', async () => {
    renderApp('/watchlist');
    const table = await screen.findByRole('table', { name: 'Watchlist' });
    expect(within(table).getByRole('rowheader', { name: /NVDA/ })).toBeInTheDocument();
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(2);
    expect(within(table).getAllByText(/^[▲▼■]?\s*$|%/).length).toBeGreaterThan(0);
  });

  it('adds a symbol (waiting for its price) and removes it again', async () => {
    const user = userEvent.setup();
    renderApp('/watchlist');
    await screen.findByRole('table', { name: 'Watchlist' });
    await user.type(screen.getByLabelText('Symbol'), 'zzzz');
    await user.click(screen.getByRole('button', { name: 'Add to watchlist' }));
    expect(await screen.findByRole('rowheader', { name: /ZZZZ/ })).toBeInTheDocument();
    expect(screen.getByText('Waiting for price…')).toBeInTheDocument();
    expect(screen.getByLabelText('Symbol')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Remove ZZZZ from watchlist' }));
    await waitFor(() => expect(screen.queryByRole('rowheader', { name: /ZZZZ/ })).not.toBeInTheDocument());
  });

  it('validates the symbol and reports duplicates and failed removals', async () => {
    const user = userEvent.setup();
    renderApp('/watchlist');
    await screen.findByRole('table', { name: 'Watchlist' });
    await user.type(screen.getByLabelText('Symbol'), 'a b');
    await user.click(screen.getByRole('button', { name: 'Add to watchlist' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Use letters, digits');

    await user.clear(screen.getByLabelText('Symbol'));
    await user.type(screen.getByLabelText('Symbol'), 'nvda');
    await user.click(screen.getByRole('button', { name: 'Add to watchlist' }));
    expect(await screen.findByText('NVDA is already on your watchlist.')).toBeInTheDocument();

    server.use(http.delete('/api/watchlist/:symbol', () => HttpResponse.json({ error: { code: 'X', message: 'Cannot remove' } }, { status: 500 })));
    await user.click(screen.getByRole('button', { name: 'Remove NVDA from watchlist' }));
    expect(await screen.findByText('Cannot remove')).toBeInTheDocument();
  });

  it('shows an empty state and an error state with retry', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/watchlist', () => HttpResponse.error(), { once: true }));
    renderApp('/watchlist');
    expect(await screen.findByText('Could not load watchlist')).toBeInTheDocument();
    server.use(http.get('/api/watchlist', () => HttpResponse.json({ items: [] })));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Your watchlist is empty' })).toBeInTheDocument();
  });
});
