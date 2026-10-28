import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { Transaction } from '@portfolio/shared';
import { renderApp } from '../test/utils';
import { server } from '../mocks/server';
import { listTransactions, resetDb } from '../mocks/db';
import { buildSampleCsv } from '../features/transactions/sampleCsv';
import { formatDate } from '../lib/format';

const txn = (over: Partial<Transaction>): Transaction => ({
  id: 't1',
  userId: 'demo',
  portfolioId: 'default',
  date: '2024-03-05',
  type: 'BUY',
  symbol: 'AAPL',
  quantity: 2,
  price: 100,
  fee: 1,
  currency: 'USD',
  createdAt: '2024-03-05T00:00:00Z',
  ...over,
});

const rows = () => within(screen.getByRole('table', { name: 'Transactions, newest first' })).getAllByRole('row').slice(1);

describe('TransactionsPage', () => {
  it('shows a loading region, then lists transactions newest first', async () => {
    const all = listTransactions();
    renderApp('/transactions');
    expect(screen.getByText('Loading transactions')).toBeInTheDocument();
    await screen.findByRole('table', { name: 'Transactions, newest first' });
    expect(rows()).toHaveLength(all.length);
    expect(rows()[0]).toHaveTextContent(formatDate(all[0]!.date));
    expect(rows()[0]).toHaveTextContent(all[0]!.symbol);
  });

  it('computes totals per type, formats sub-unit prices and labels imported rows', async () => {
    server.use(
      http.get('/api/transactions', () =>
        HttpResponse.json({
          transactions: [
            txn({ id: 'b', type: 'BUY', quantity: 2, price: 100, fee: 1, note: 'Core', fxRate: 1.0842 }),
            txn({ id: 's', type: 'SELL', quantity: 1, price: 150, fee: 2 }),
            txn({ id: 'd', type: 'DIVIDEND', quantity: 10, price: 0.123456, fee: 0.5, importId: 'imp-1' }),
            txn({ id: 'e', symbol: 'ASML.AS', currency: 'EUR', quantity: 1, price: 700, fee: 0, fxRate: 1 }),
          ],
        }),
      ),
    );
    renderApp('/transactions');
    await screen.findByRole('table', { name: 'Transactions, newest first' });
    const [buy, sell, div, eurBuy] = rows();
    expect(buy).toHaveTextContent('US$ 201,00');
    expect(buy).toHaveTextContent('Core');
    // Broker FX rate: the EUR equivalent (201 / 1.0842) and the rate itself are shown under the total.
    const fxLine = within(buy!).getByTitle('Broker FX rate: 1,0842 USD per 1 EUR');
    expect(fxLine).toHaveTextContent(/^≈ € 185,39 · FX 1,0842$/);
    expect(sell).toHaveTextContent('US$ 148,00');
    expect(sell).not.toHaveTextContent('FX');
    expect(within(sell!).getAllByRole('cell').at(-2)).toHaveTextContent(/^$/);
    expect(div).toHaveTextContent('US$ 0,123456');
    expect(div).toHaveTextContent('US$ 0,73');
    // A rate on a EUR trade is meaningless and not shown.
    expect(eurBuy).toHaveTextContent('€ 700,00');
    expect(eurBuy).not.toHaveTextContent('FX');
    expect(div).toHaveTextContent('Imported');
    expect(within(div!).getByText('DIVIDEND')).toBeInTheDocument();
  });

  it('shows an error state and retries', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/transactions', () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'DB offline' } }, { status: 500 }), { once: true }));
    renderApp('/transactions');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load transactions');
    expect(alert).toHaveTextContent('DB offline');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Transactions, newest first' })).toBeInTheDocument();
  });

  it('shows an empty state whose actions open the dialogs', async () => {
    const user = userEvent.setup();
    resetDb({ empty: true });
    renderApp('/transactions');
    expect(await screen.findByRole('heading', { name: 'No transactions yet' })).toBeInTheDocument();
    // Header + empty-state both offer the actions.
    expect(screen.getAllByRole('button', { name: 'Add transaction' })).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: 'Import CSV' })[1]!);
    expect(screen.getByRole('dialog', { name: 'Import transactions from CSV' })).toBeInTheDocument();
  });

  it('adds a transaction through the dialog and announces it', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/transactions');
    await screen.findByRole('table');
    const before = rows().length;

    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    expect(router.state.location.search).toBe('?action=add');
    const dialog = screen.getByRole('dialog', { name: 'Add transaction' });
    expect(within(dialog).getByLabelText('Date')).toHaveFocus();

    await user.type(within(dialog).getByLabelText('Symbol'), 'asml.as');
    await user.type(within(dialog).getByLabelText('Quantity'), '1,5');
    await user.type(within(dialog).getByLabelText('Price per unit'), '700');
    await user.click(within(dialog).getByRole('button', { name: 'Save transaction' }));

    expect(await screen.findByText('Added buy of 1,5 ASML.AS.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Added buy of 1,5 ASML.AS.');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(router.state.location.search).toBe('');
    });
    await waitFor(() => expect(rows()).toHaveLength(before + 1));
  });

  it('opens the add dialog from a deep link and closes it via Cancel, Escape or the close button', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/transactions?action=add');
    expect(screen.getByRole('dialog', { name: 'Add transaction' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(router.state.location.search).toBe('');

    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import CSV' }));
    expect(router.state.location.search).toBe('?action=import');
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores unknown ?action values', async () => {
    renderApp('/transactions?action=delete-everything');
    await screen.findByRole('table');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('imports a CSV from the dialog and closes it with Done', async () => {
    const user = userEvent.setup();
    resetDb({ empty: true });
    server.use(
      http.get('/api/imports/:id', ({ params }) =>
        HttpResponse.json({
          importId: String(params.id), userId: 'demo', fileName: 'trades.csv', status: 'COMPLETED', rowCount: 5, importedCount: 5,
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:01Z',
        }),
      ),
    );
    renderApp('/transactions?action=import');
    const dialog = screen.getByRole('dialog', { name: 'Import transactions from CSV' });
    await user.upload(within(dialog).getByLabelText('CSV file'), new File([buildSampleCsv()], 'trades.csv', { type: 'text/csv' }));
    await user.click(within(dialog).getByRole('button', { name: 'Upload & import' }));
    expect(await within(dialog).findByText('✓ Import completed', undefined, { timeout: 4000 })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  describe('delete', () => {
    it('asks for confirmation and can be cancelled', async () => {
      const user = userEvent.setup();
      const first = listTransactions()[0]!;
      renderApp('/transactions');
      await screen.findByRole('table');
      const label = `Delete ${first.type.toLowerCase()} ${first.symbol} on ${formatDate(first.date)}`;
      const trigger = screen.getByRole('button', { name: label });

      await user.click(trigger);
      const dialog = screen.getByRole('alertdialog', { name: 'Delete transaction?' });
      expect(dialog).toHaveAccessibleDescription(new RegExp(`^This removes the ${first.type.toLowerCase()} of .* ${first.symbol} on .* Holdings and returns will be recalculated\\.$`));
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();

      await user.click(trigger);
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(listTransactions()[0]!.id).toBe(first.id);
    });

    it('deletes on confirm and announces the result', async () => {
      const user = userEvent.setup();
      const first = listTransactions()[0]!;
      renderApp('/transactions');
      await screen.findByRole('table');
      const before = rows().length;
      await user.click(screen.getByRole('button', { name: `Delete ${first.type.toLowerCase()} ${first.symbol} on ${formatDate(first.date)}` }));
      await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

      expect(await screen.findByText(`Deleted ${first.type.toLowerCase()} of ${first.symbol} on ${formatDate(first.date)}.`)).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      await waitFor(() => expect(rows()).toHaveLength(before - 1));
      expect(listTransactions().some((t) => t.id === first.id)).toBe(false);
    });

    it('shows a pending state and the server error inside the dialog, and clears it on reopen', async () => {
      const user = userEvent.setup();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      server.use(
        http.delete('/api/transactions/:id', async () => {
          await gate;
          return HttpResponse.json({ error: { code: 'INVALID_POSITION', message: 'Deleting this buy would make AAPL negative' } }, { status: 422 });
        }),
      );
      renderApp('/transactions');
      await screen.findByRole('table');
      const trigger = screen.getAllByRole('button', { name: /^Delete buy/ })[0]!;
      await user.click(trigger);
      const dialog = screen.getByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
      expect(within(dialog).getByRole('button', { name: 'Deleting…' })).toBeDisabled();

      release();
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Deleting this buy would make AAPL negative');
      expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await user.click(trigger);
      expect(within(screen.getByRole('alertdialog')).queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});

const cardOrder = () => [...document.querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset.cardId);

describe('TransactionsPage layout', () => {
  it('keeps the table as one card and puts the customize toggle in the page header', async () => {
    renderApp('/transactions');
    await screen.findByRole('table', { name: 'Transactions, newest first' });
    expect(cardOrder()).toEqual(['transactions-table']);
    const actions = document.querySelector<HTMLElement>('[data-page-header-actions]')!;
    expect(within(actions).getByRole('button', { name: 'Customize layout' })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: 'Add transaction' })).toBeInTheDocument();
  });

  it('hides and shows the table card', async () => {
    const user = userEvent.setup();
    renderApp('/transactions');
    await screen.findByRole('table', { name: 'Transactions, newest first' });
    await user.click(screen.getByRole('button', { name: 'Customize layout' }));
    await user.click(screen.getByRole('button', { name: 'Hide Transactions' }));
    expect(cardOrder()).toEqual([]);
    expect(screen.queryByRole('table', { name: 'Transactions, newest first' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show Transactions' }));
    expect(await screen.findByRole('table', { name: 'Transactions, newest first' })).toBeInTheDocument();
  });
});
