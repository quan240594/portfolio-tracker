import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MAX_PORTFOLIOS } from '@portfolio/shared';
import { renderApp } from '../../test/utils';
import { server } from '../../mocks/server';
import { createPortfolio, deletePortfolio, listPortfolios, listTransactions } from '../../mocks/db';
import { validatePortfolioName } from './ManagePortfoliosDialog';

const apiError = (status: number, code: string, message: string, details?: unknown) =>
  HttpResponse.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });

async function openManage(route = '/') {
  const user = userEvent.setup();
  const view = renderApp(route);
  await user.click(screen.getByRole('button', { name: 'Manage portfolios' }));
  const dialog = screen.getByRole('dialog', { name: 'Manage portfolios' });
  await within(dialog).findByRole('list', { name: 'Portfolios' });
  return { user, dialog, ...view };
}

const rowOf = (dialog: HTMLElement, name: string) =>
  within(within(dialog).getByRole('list', { name: 'Portfolios' }))
    .getAllByRole('listitem')
    .find((li) => li.textContent?.includes(name))!;

const count = (portfolioId: string) => listTransactions(portfolioId).length;

describe('ManagePortfoliosDialog', () => {
  it('lists portfolios with transaction counts and focuses the name field', async () => {
    const { dialog } = await openManage();
    expect(within(dialog).getByLabelText('New portfolio name')).toHaveFocus();
    expect(await within(rowOf(dialog, 'Main portfolio')).findByText(`${count('default')} transactions`)).toBeInTheDocument();
    expect(within(rowOf(dialog, 'Trading 212')).getByText(`${count('trading-212')} transactions`)).toBeInTheDocument();
    expect(within(dialog).getByText(`Names must be unique. Up to ${MAX_PORTFOLIOS} portfolios.`)).toBeInTheDocument();
  });

  it('creates a portfolio and validates the name inline, including duplicates from the API', async () => {
    const { user, dialog } = await openManage();
    const input = within(dialog).getByLabelText('New portfolio name');
    const submit = within(dialog).getByRole('button', { name: 'Create portfolio' });

    await user.click(submit);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Name is required');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/Name is required/);

    await user.type(input, 'x'.repeat(61));
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    await user.click(submit);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Name is too long (max 60 characters)');

    await user.clear(input);
    await user.type(input, '  main PORTFOLIO ');
    await user.click(submit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A portfolio named “main PORTFOLIO” already exists.');

    await user.clear(input);
    await user.type(input, '  Long term  {Enter}');
    expect(await within(dialog).findByText('Created “Long term”.')).toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(await within(dialog).findByText('Long term')).toBeInTheDocument();
    expect(within(rowOf(dialog, 'Long term')).getByText('0 transactions')).toBeInTheDocument();
    expect(within(screen.getByRole('combobox', { name: 'Portfolio' })).getByRole('option', { name: 'Long term' })).toBeInTheDocument();
    expect(listPortfolios().map((p) => p.name)).toContain('Long term');
  });

  it(`shows the API error when more than ${MAX_PORTFOLIOS} portfolios would exist`, async () => {
    for (let i = listPortfolios().length; i < MAX_PORTFOLIOS; i++) createPortfolio(`P${i}`);
    const { user, dialog } = await openManage();
    await user.type(within(dialog).getByLabelText('New portfolio name'), 'One too many');
    await user.click(within(dialog).getByRole('button', { name: 'Create portfolio' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(`You can have at most ${MAX_PORTFOLIOS} portfolios.`);
  });

  it('renames inline: Escape cancels, duplicates are rejected, unchanged names skip the request', async () => {
    const { user, dialog } = await openManage();
    const renameButton = within(dialog).getByRole('button', { name: 'Rename Trading 212' });
    await user.click(renameButton);
    let field = within(dialog).getByLabelText('New name for Trading 212');
    expect(field).toHaveFocus();
    expect(field).toHaveValue('Trading 212');

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Manage portfolios' })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('New name for Trading 212')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Rename Trading 212' })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Rename Trading 212' }));
    field = within(dialog).getByLabelText('New name for Trading 212');
    await user.clear(field);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Name is required');

    await user.type(field, 'Main Portfolio');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A portfolio named “Main Portfolio” already exists.');
    expect(field).toHaveAccessibleDescription(/already exists/);

    // Saving the unchanged name just closes the editor.
    await user.clear(field);
    await user.type(field, 'Trading 212{Enter}');
    expect(within(dialog).queryByLabelText('New name for Trading 212')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Rename Trading 212' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).getByRole('button', { name: 'Rename Trading 212' })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Rename Trading 212' }));
    field = within(dialog).getByLabelText('New name for Trading 212');
    await user.clear(field);
    await user.type(field, 'T212{Enter}');
    expect(await within(dialog).findByText('Renamed to “T212”.')).toBeInTheDocument();
    expect(await within(dialog).findByRole('button', { name: 'Rename T212' })).toBeInTheDocument();
    expect(listPortfolios().find((p) => p.portfolioId === 'trading-212')?.name).toBe('T212');
  });

  it('deletes an empty portfolio after confirmation; Cancel returns focus to the Delete button', async () => {
    createPortfolio('Empty');
    const { user, dialog } = await openManage();

    await user.click(within(dialog).getByRole('button', { name: 'Delete Empty' }));
    expect(within(dialog).getByRole('heading', { name: 'Delete “Empty”?' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).getByRole('button', { name: 'Delete Empty' })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Delete Empty' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete portfolio' }));
    expect(await within(dialog).findByText('Deleted “Empty”.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('New portfolio name')).toHaveFocus();
    expect(listPortfolios().map((p) => p.name)).not.toContain('Empty');
  });

  it('offers a strongly confirmed force delete when the portfolio still has transactions', async () => {
    const n = count('trading-212');
    const { user, dialog, router } = await openManage('/?portfolio=trading-212');
    await user.click(within(dialog).getByRole('button', { name: 'Delete Trading 212' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete portfolio' }));

    expect(await within(dialog).findByRole('heading', { name: '“Trading 212” still has transactions' })).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(`also permanently deletes its ${n} transactions`);
    const confirmField = within(dialog).getByLabelText('Type Trading 212 to confirm');
    expect(confirmField).toHaveFocus();
    const force = within(dialog).getByRole('button', { name: `Delete portfolio and its ${n} transactions` });
    expect(force).toBeDisabled();
    await user.type(confirmField, 'Trading');
    expect(force).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(listPortfolios()).toHaveLength(2);
    await user.type(confirmField, ' 212');
    expect(force).toBeEnabled();
    await user.click(force);

    expect(await within(dialog).findByText('Deleted “Trading 212”.')).toBeInTheDocument();
    expect(listPortfolios().map((p) => p.portfolioId)).toEqual(['default']);
    expect(listTransactions().every((t) => t.portfolioId === 'default')).toBe(true);
    // The deleted portfolio was selected → the app falls back to all portfolios.
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.getByRole('combobox', { name: 'Portfolio' })).toHaveValue('all');
  });

  it('cancels a force delete and keeps the portfolio', async () => {
    const { user, dialog } = await openManage();
    await user.click(within(dialog).getByRole('button', { name: 'Delete Trading 212' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete portfolio' }));
    await within(dialog).findByLabelText('Type Trading 212 to confirm');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).getByRole('button', { name: 'Delete Trading 212' })).toHaveFocus();
    expect(listPortfolios()).toHaveLength(2);
  });

  it('uses the client-side count when the API gives none, and a generic label when unknown', async () => {
    server.use(http.delete('/api/portfolios/:id', () => apiError(409, 'PORTFOLIO_NOT_EMPTY', 'Not empty')));
    const { user, dialog } = await openManage();
    await within(rowOf(dialog, 'Main portfolio')).findByText(/transactions$/);
    await user.click(within(dialog).getByRole('button', { name: 'Delete Main portfolio' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete portfolio' }));
    expect(
      await within(dialog).findByRole('button', { name: `Delete portfolio and its ${count('default')} transactions` }),
    ).toBeInTheDocument();
  });

  it('falls back to "all its transactions" without any count', async () => {
    server.use(
      http.delete('/api/portfolios/:id', () => apiError(409, 'PORTFOLIO_NOT_EMPTY', 'Not empty')),
      http.get('/api/transactions', () => apiError(500, 'INTERNAL', 'boom')),
    );
    const { user, dialog } = await openManage();
    await user.click(within(dialog).getByRole('button', { name: 'Delete Main portfolio' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete portfolio' }));
    expect(await within(dialog).findByRole('button', { name: 'Delete portfolio and all its transactions' })).toBeInTheDocument();
  });

  it('explains LAST_PORTFOLIO in friendly terms', async () => {
    deletePortfolio('trading-212', true);
    const { user, dialog } = await openManage();
    await user.click(within(dialog).getByRole('button', { name: 'Delete Main portfolio' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete portfolio' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('“Main portfolio” is your only portfolio — you always need at least one.');
    expect(within(dialog).getByRole('button', { name: 'Delete Main portfolio' })).toHaveFocus();
    expect(listPortfolios()).toHaveLength(1);

    // Starting another action clears the message.
    await user.click(within(dialog).getByRole('button', { name: 'Rename Main portfolio' }));
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows other delete errors in the confirmation and force views', async () => {
    let calls = 0;
    server.use(
      http.delete('/api/portfolios/:id', () => {
        calls += 1;
        return calls === 2 ? apiError(409, 'PORTFOLIO_NOT_EMPTY', 'Not empty', { transactionCount: 1 }) : apiError(500, 'INTERNAL', 'Database unavailable');
      }),
    );
    const { user, dialog } = await openManage();
    await user.click(within(dialog).getByRole('button', { name: 'Delete Trading 212' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete portfolio' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Database unavailable');

    await user.click(within(dialog).getByRole('button', { name: 'Delete portfolio' }));
    const force = await within(dialog).findByRole('button', { name: 'Delete portfolio and its 1 transaction' });
    await user.type(within(dialog).getByLabelText('Type Trading 212 to confirm'), 'Trading 212');
    await user.click(force);
    await waitFor(() => expect(within(dialog).getAllByRole('alert').some((a) => a.textContent === 'Database unavailable')).toBe(true));
  });

  it('shows an error with retry when the portfolios cannot be loaded, and resets when closed', async () => {
    server.use(http.get('/api/portfolios', () => apiError(500, 'INTERNAL', 'down'), { once: true }));
    const user = userEvent.setup();
    renderApp('/');
    await user.click(screen.getByRole('button', { name: 'Manage portfolios' }));
    const dialog = screen.getByRole('dialog', { name: 'Manage portfolios' });
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Could not load portfolios');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByRole('list', { name: 'Portfolios' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Delete Trading 212' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage portfolios' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Manage portfolios' }));
    expect(within(screen.getByRole('dialog', { name: 'Manage portfolios' })).getByRole('list', { name: 'Portfolios' })).toBeInTheDocument();
  });

  it('shows a loading message before the list arrives', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get('/api/portfolios', async () => {
        await gate;
        return HttpResponse.json({ portfolios: listPortfolios() });
      }),
    );
    const user = userEvent.setup();
    renderApp('/');
    await user.click(screen.getByRole('button', { name: 'Manage portfolios' }));
    expect(screen.getByText('Loading portfolios…')).toBeInTheDocument();
    release();
    expect(await screen.findByRole('list', { name: 'Portfolios' })).toBeInTheDocument();
  });
});

describe('validatePortfolioName', () => {
  it('trims and reports friendly messages', () => {
    expect(validatePortfolioName('  ISA ')).toEqual({ name: 'ISA' });
    expect(validatePortfolioName('   ')).toEqual({ error: 'Name is required' });
    expect(validatePortfolioName('y'.repeat(61))).toEqual({ error: 'Name is too long (max 60 characters)' });
  });
});
