import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderApp } from '../test/utils';
import { server } from '../mocks/server';

const picker = () => screen.findByRole('heading', { name: 'Choose a portfolio' });

async function openMain() {
  const user = userEvent.setup();
  renderApp('/rebalance?portfolio=default');
  expect(await screen.findByRole('heading', { name: 'Categories & targets' })).toBeInTheDocument();
  return user;
}

describe('RebalancePage', () => {
  it('asks for a portfolio in the combined view and remembers the choice', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/rebalance');
    await picker();
    await user.click(screen.getByRole('button', { name: 'Main portfolio' }));
    expect(await screen.findByRole('heading', { name: 'Categories & targets' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?portfolio=default');
  });

  it('lists the categories with their holdings and the unallocated remainder', async () => {
    await openMain();
    expect(await screen.findByText('Core ETFs')).toBeInTheDocument();
    expect(screen.getByText(/Targets total 100% · 0% left unallocated/)).toBeInTheDocument();
    expect(screen.getByText('VWRL.AS, IWDA.AS')).toBeInTheDocument();
  });

  it('plans a buy-only investment: drift table, trades and leftover cash', async () => {
    const user = await openMain();
    await screen.findByText('Core ETFs');
    expect(screen.getByText(/Set an amount and calculate/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Calculate trades' }));
    const drift = await screen.findByRole('table', { name: 'Drift from target allocation per category' });
    expect(within(drift).getByRole('rowheader', { name: 'Core ETFs' })).toBeInTheDocument();
    expect(within(drift).getByRole('rowheader', { name: 'Unallocated' })).toBeInTheDocument();
    const trades = screen.getByRole('table', { name: 'Suggested trades' });
    expect(within(trades).getAllByText('BUY').length).toBeGreaterThan(0);
    expect(within(trades).queryByText('SELL')).not.toBeInTheDocument();
    expect(screen.getByText(/Leftover cash:/)).toBeInTheDocument();
  });

  it('validates the amount and supports a full rebalance with whole units and a minimum trade', async () => {
    const user = await openMain();
    await screen.findByText('Core ETFs');
    await user.clear(screen.getByLabelText(/Amount to invest/));
    await user.click(screen.getByRole('button', { name: 'Calculate trades' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the amount you want to invest');

    await user.click(screen.getByRole('radio', { name: 'Full rebalance' }));
    await user.clear(screen.getByLabelText(/New money to add/));
    await user.type(screen.getByLabelText(/New money to add/), '-5');
    await user.click(screen.getByRole('button', { name: 'Calculate trades' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Amounts cannot be negative');

    await user.clear(screen.getByLabelText(/New money to add/));
    await user.type(screen.getByLabelText(/New money to add/), '0');
    await user.type(screen.getByLabelText('Minimum trade (EUR)'), '50');
    await user.click(screen.getByRole('button', { name: 'Calculate trades' }));
    const sells = await screen.findByRole('table', { name: 'Suggested trades' });
    expect(within(sells).getAllByText('SELL').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('radio', { name: 'Buy only' }));
    await user.clear(screen.getByLabelText(/Amount to invest/));
    await user.type(screen.getByLabelText(/Amount to invest/), '5000');
    await user.click(screen.getByLabelText(/Whole units only/));
    await user.click(screen.getByRole('button', { name: 'Calculate trades' }));
    await waitFor(() => expect(screen.queryAllByText('SELL')).toHaveLength(0));
    const trades = screen.getByRole('table', { name: 'Suggested trades' });
    for (const cell of within(trades).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[2]!)) {
      expect(cell.textContent).toMatch(/^\d+$/);
    }
  });

  it('copies the trades as CSV, and reports a clipboard failure', async () => {
    const user = await openMain();
    await screen.findByText('Core ETFs');
    await user.click(screen.getByRole('button', { name: 'Calculate trades' }));
    await screen.findByRole('table', { name: 'Suggested trades' });
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce();
    await user.click(screen.getByRole('button', { name: 'Copy as CSV' }));
    expect(await screen.findByText(/Copied \d+ trades/)).toBeInTheDocument();
    expect(writeText.mock.calls[0]![0]).toMatch(/^symbol,name,action,units,price,value\n/);

    writeText.mockRejectedValueOnce(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy as CSV' }));
    expect(await screen.findByText('Could not access the clipboard.')).toBeInTheDocument();
  });

  it('says so when nothing has to be traded', async () => {
    const user = await openMain();
    await screen.findByText('Core ETFs');
    await user.clear(screen.getByLabelText(/Amount to invest/));
    await user.type(screen.getByLabelText(/Amount to invest/), '0,01');
    await user.type(screen.getByLabelText('Minimum trade (EUR)'), '1000');
    await user.click(screen.getByRole('button', { name: 'Calculate trades' }));
    expect(await screen.findByText('No trades needed with these settings.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy as CSV' })).not.toBeInTheDocument();
  });

  it('shows an error when the plan cannot be calculated and recovers', async () => {
    const user = await openMain();
    await screen.findByText('Core ETFs');
    server.use(http.get('/api/portfolios/default/rebalance', () => HttpResponse.json({ error: { code: 'X', message: 'Boom' } }, { status: 500 }), { once: true }));
    await user.click(screen.getByRole('button', { name: 'Calculate trades' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Suggested trades' })).toBeInTheDocument();
  });

  it('shows an error state when the categories fail to load', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/portfolios/default/categories', () => HttpResponse.error(), { once: true }));
    renderApp('/rebalance?portfolio=default');
    expect(await screen.findByText('Could not load categories')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Core ETFs')).toBeInTheDocument();
  });

  it('shows how an empty portfolio looks', async () => {
    renderApp('/rebalance?portfolio=trading-212');
    expect(await screen.findByText(/No categories yet/)).toBeInTheDocument();
  });

  describe('category editor', () => {
    it('adds a category with holdings, rejecting invalid input and over-allocation', async () => {
      const user = await openMain();
      await screen.findByText('Core ETFs');
      await user.click(screen.getByRole('button', { name: 'Add category' }));
      const dialog = screen.getByRole('dialog', { name: 'New category' });

      await user.click(within(dialog).getByRole('button', { name: 'Save category' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Name is required');
      await user.type(within(dialog).getByLabelText('Name'), 'Bonds');
      await user.type(within(dialog).getByLabelText('Target weight (%)'), '150');
      await user.click(within(dialog).getByRole('button', { name: 'Save category' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Target must be a number between 0 and 100');

      await user.clear(within(dialog).getByLabelText('Target weight (%)'));
      await user.type(within(dialog).getByLabelText('Target weight (%)'), '10');
      await user.click(within(dialog).getByRole('button', { name: 'Save category' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('add up to 110%');

      await user.clear(within(dialog).getByLabelText('Target weight (%)'));
      await user.type(within(dialog).getByLabelText('Target weight (%)'), '0');
      await user.click(within(dialog).getByRole('checkbox', { name: /Cash \(EUR\)/ }));
      await user.click(within(dialog).getByRole('button', { name: 'Save category' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await screen.findByText('Bonds')).toBeInTheDocument();
      expect(screen.getByText('CASH.EUR')).toBeInTheDocument();
    });

    it('edits a category and moves holdings between categories', async () => {
      const user = await openMain();
      await screen.findByText('Core ETFs');
      await user.click(screen.getByRole('button', { name: 'Edit Single stocks' }));
      const dialog = screen.getByRole('dialog', { name: 'Edit Single stocks' });
      expect(within(dialog).getByRole('checkbox', { name: /ASML/ })).toBeChecked();
      expect(within(dialog).getAllByText('in Core ETFs')).toHaveLength(2);
      await user.click(within(dialog).getByRole('checkbox', { name: /VWRL\.AS/ }));
      await user.clear(within(dialog).getByLabelText('Name'));
      await user.type(within(dialog).getByLabelText('Name'), 'Stocks');
      await user.click(within(dialog).getByRole('button', { name: 'Save category' }));
      expect(await screen.findByText('Stocks')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText('IWDA.AS')).toBeInTheDocument());
    });

    it('deletes a category after confirmation', async () => {
      const user = await openMain();
      await screen.findByText('Core ETFs');
      await user.click(screen.getByRole('button', { name: 'Delete Crypto' }));
      const dialog = screen.getByRole('alertdialog', { name: 'Delete category?' });
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Delete Crypto' }));
      await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.queryByText('Crypto')).not.toBeInTheDocument());
      expect(screen.getByText(/Targets total 90%/)).toBeInTheDocument();
    });

    it('shows the server error when deleting fails', async () => {
      const user = await openMain();
      await screen.findByText('Core ETFs');
      server.use(http.delete('/api/portfolios/default/categories/:cid', () => HttpResponse.json({ error: { code: 'X', message: 'Nope' } }, { status: 500 })));
      await user.click(screen.getByRole('button', { name: 'Delete Crypto' }));
      await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
      expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('Nope');
    });
  });
});
