import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderApp } from '../test/utils';
import { server } from '../mocks/server';

async function openAssets() {
  const user = userEvent.setup();
  renderApp('/assets?portfolio=default');
  await screen.findByRole('heading', { name: 'Rental property (share)' });
  return user;
}

describe('AssetsPage', () => {
  it('asks for a portfolio in the combined view', async () => {
    renderApp('/assets');
    expect(await screen.findByRole('heading', { name: 'Choose a portfolio' })).toBeInTheDocument();
  });

  it('lists the custom assets with value, growth and last valuation', async () => {
    await openAssets();
    const savings = screen.getByRole('heading', { name: 'Savings account' }).closest('li')!;
    expect(within(savings).getByText(/Savings \/ deposit · EUR · grows 2,0% a year · last valuation/)).toBeInTheDocument();
    expect(within(savings).getByText(/Invested/)).toBeInTheDocument();
  });

  it('shows an empty state and adds the first asset in a foreign currency', async () => {
    const user = userEvent.setup();
    renderApp('/assets?portfolio=trading-212');
    expect(await screen.findByRole('heading', { name: 'No custom assets yet' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add asset' }));
    const dialog = screen.getByRole('dialog', { name: 'Add custom asset' });

    await user.click(within(dialog).getByRole('button', { name: 'Save asset' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Name is required');
    await user.type(within(dialog).getByLabelText('Name'), 'P2P loans');
    await user.click(within(dialog).getByRole('button', { name: 'Save asset' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter the current value');
    await user.type(within(dialog).getByLabelText('Current value'), '2500');
    await user.clear(within(dialog).getByLabelText('Currency'));
    await user.type(within(dialog).getByLabelText('Currency'), 'US');
    await user.click(within(dialog).getByRole('button', { name: 'Save asset' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Use a 3-letter currency code');
    await user.type(within(dialog).getByLabelText('Currency'), 'D');
    await user.type(within(dialog).getByLabelText(/Amount invested/), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Save asset' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Cost basis must be 0 or more');
    await user.clear(within(dialog).getByLabelText(/Amount invested/));
    await user.type(within(dialog).getByLabelText(/Amount invested/), '2400');
    await user.type(within(dialog).getByLabelText(/Annual growth/), '6,5');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'BOND');
    await user.click(within(dialog).getByRole('button', { name: 'Save asset' }));

    const card = (await screen.findByRole('heading', { name: 'P2P loans' })).closest('li')!;
    expect(within(card).getByText(/Bond \/ loan · USD · grows 6,5% a year/)).toBeInTheDocument();
    expect(within(card).getByText(/US\$\s2\.500,00/)).toBeInTheDocument();
  });

  it('edits an asset', async () => {
    const user = await openAssets();
    await user.click(screen.getByRole('button', { name: 'Edit Rental property (share)' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Rental property (share)' });
    expect(within(dialog).queryByLabelText('Currency')).not.toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Apartment');
    await user.clear(within(dialog).getByLabelText(/Annual growth/));
    await user.type(within(dialog).getByLabelText(/Annual growth/), 'abc');
    await user.click(within(dialog).getByRole('button', { name: 'Save asset' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Growth must be a number');
    await user.clear(within(dialog).getByLabelText(/Annual growth/));
    await user.click(within(dialog).getByRole('button', { name: 'Save asset' }));
    expect(await screen.findByRole('heading', { name: 'Apartment' })).toBeInTheDocument();
  });

  it('shows the server error when saving fails', async () => {
    const user = await openAssets();
    server.use(http.patch('/api/portfolios/default/assets/:aid', () => HttpResponse.json({ error: { code: 'X', message: 'Not today' } }, { status: 500 })));
    await user.click(screen.getByRole('button', { name: 'Edit Savings account' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save asset' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('Not today');
  });

  it('adds and deletes valuation points', async () => {
    const user = await openAssets();
    await user.click(screen.getByRole('button', { name: 'Valuations of Savings account' }));
    const dialog = screen.getByRole('dialog', { name: 'Valuations · Savings account' });
    const points = () => within(within(dialog).getByRole('list', { name: 'Valuation points' })).getAllByRole('listitem');
    expect(points()).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: /Delete valuation of/ })).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: 'Save valuation' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter the value on that date');
    await user.type(within(dialog).getByLabelText('Value (EUR)'), '8.200,50');
    await user.click(within(dialog).getByRole('button', { name: 'Save valuation' }));
    await waitFor(() => expect(points()).toHaveLength(2));

    await user.click(within(points()[0]!).getByRole('button', { name: /Delete valuation of/ }));
    await waitFor(() => expect(points()).toHaveLength(1));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reports valuation errors from the server', async () => {
    const user = await openAssets();
    await user.click(screen.getByRole('button', { name: 'Valuations of Rental property (share)' }));
    const dialog = screen.getByRole('dialog');
    server.use(
      http.put('/api/portfolios/default/assets/:aid/valuations', () => HttpResponse.json({ error: { code: 'X', message: 'Too many' } }, { status: 422 })),
      http.delete('/api/portfolios/default/assets/:aid/valuations/:date', () => HttpResponse.json({ error: { code: 'X', message: 'Gone' } }, { status: 404 })),
    );
    await user.type(within(dialog).getByLabelText(/Value/), '1');
    await user.click(within(dialog).getByRole('button', { name: 'Save valuation' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Too many');
    await user.click(within(dialog).getAllByRole('button', { name: /Delete valuation of/ })[0]!);
    expect(await within(dialog).findByText('Gone')).toBeInTheDocument();
  });

  it('deletes an asset after confirmation and shows failures', async () => {
    const user = await openAssets();
    await user.click(screen.getByRole('button', { name: 'Delete Start-up stake' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    server.use(http.delete('/api/portfolios/default/assets/:aid', () => HttpResponse.json({ error: { code: 'X', message: 'Locked' } }, { status: 409 }), { once: true }));
    await user.click(screen.getByRole('button', { name: 'Delete Start-up stake' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('Locked');
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Start-up stake' })).not.toBeInTheDocument());
  });

  it('shows an error state with retry', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/portfolios/default/assets', () => HttpResponse.error(), { once: true }));
    renderApp('/assets?portfolio=default');
    expect(await screen.findByText('Could not load assets')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Savings account' })).toBeInTheDocument();
  });
});

const cardOrder = () => [...document.querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset.cardId);

describe('AssetsPage layout', () => {
  it('keeps the default card order and puts the customize toggle in the page header', async () => {
    await openAssets();
    expect(cardOrder()).toEqual(['securities', 'classification', 'custom-assets']);
    const actions = document.querySelector<HTMLElement>('[data-page-header-actions]')!;
    expect(within(actions).getByRole('button', { name: 'Customize layout' })).toBeInTheDocument();
  });

  it('moves and hides cards', async () => {
    const user = await openAssets();
    await user.click(screen.getByRole('button', { name: 'Customize layout' }));
    await user.click(screen.getByRole('button', { name: 'Move Custom assets up' }));
    expect(cardOrder()).toEqual(['securities', 'custom-assets', 'classification']);

    await user.click(screen.getByRole('button', { name: 'Hide Custom assets' }));
    expect(cardOrder()).toEqual(['securities', 'classification']);
    expect(screen.queryByRole('heading', { name: 'Savings account' })).not.toBeInTheDocument();
  });
});
