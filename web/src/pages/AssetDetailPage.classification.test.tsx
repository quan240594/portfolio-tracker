import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { api } from '../mocks/utils';
import { renderApp } from '../test/utils';

async function openAsset(path: string) {
  const user = userEvent.setup();
  renderApp(path);
  await screen.findByRole('heading', { level: 1 });
  const about = await screen.findByRole('region', { name: /^About / });
  return { user, about: within(about) };
}

const crumbs = () => screen.getByRole('navigation', { name: 'Breadcrumb' });

describe('AssetDetailPage: classification', () => {
  it('shows the asset class next to the other facts, with no indicator while nothing is overridden', async () => {
    const { about } = await openAsset('/assets/AAPL?portfolio=all');
    expect(about.getByText('Asset class').nextElementSibling).toHaveTextContent('Stock');
    expect(about.getByText('Sector').nextElementSibling).toHaveTextContent('Technology');
    expect(about.queryByText('Edited by you')).not.toBeInTheDocument();
    expect(await about.findByRole('button', { name: 'Edit classification' })).toBeInTheDocument();
  });

  it('edits the classification: the header and the About card follow, the indicator shows, focus returns to the button', async () => {
    const { user, about } = await openAsset('/assets/AAPL?portfolio=all');
    const edit = await about.findByRole('button', { name: 'Edit classification' });
    await user.click(edit);
    const dialog = within(screen.getByRole('dialog', { name: 'Edit classification of AAPL' }));
    expect(dialog.getByLabelText('Sector')).toHaveValue('Technology');
    expect(dialog.getByLabelText('Sector')).toHaveAccessibleDescription('Provider value: Technology');
    await user.clear(dialog.getByLabelText('Sector'));
    await user.type(dialog.getByLabelText('Sector'), 'Invented Sector');
    await user.clear(dialog.getByLabelText('Name'));
    await user.type(dialog.getByLabelText('Name'), 'Apple Invented');
    await user.selectOptions(dialog.getByLabelText('Asset class'), 'ETF');
    await user.click(dialog.getByRole('button', { name: 'Save classification' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('heading', { level: 1, name: 'Apple Invented' })).toBeInTheDocument();
    expect(crumbs()).toHaveTextContent('Invented Sector');
    expect(crumbs()).toHaveTextContent('United States');
    expect(about.getByText('Sector').nextElementSibling).toHaveTextContent('Invented Sector');
    expect(about.getByText('Asset class').nextElementSibling).toHaveTextContent('ETF');
    expect(about.getByText('Edited by you')).toBeInTheDocument();
    expect(edit).toHaveFocus();
  });

  it('resets to the automatic values', async () => {
    const { user, about } = await openAsset('/assets/AAPL?portfolio=all');
    await user.click(await about.findByRole('button', { name: 'Edit classification' }));
    await user.type(within(screen.getByRole('dialog')).getByLabelText('Country'), ' Invented');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save classification' }));
    expect(await about.findByText('Edited by you')).toBeInTheDocument();

    await user.click(about.getByRole('button', { name: 'Edit classification' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset to automatic' }));
    await waitFor(() => expect(about.queryByText('Edited by you')).not.toBeInTheDocument());
    expect(about.getByText('Country').nextElementSibling).toHaveTextContent('United States');
    expect(crumbs()).not.toHaveTextContent('Invented');
  });

  it('can classify a security that is not held, starting from the public profile', async () => {
    const { user, about } = await openAsset('/assets/NVDA?portfolio=all');
    await user.click(await about.findByRole('button', { name: 'Edit classification' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Edit classification of NVDA' }));
    expect(dialog.getByLabelText('Country')).toHaveValue('United States');
    expect(dialog.getByLabelText('Country')).toHaveAccessibleDescription('Automatic value: United States');
    await user.type(dialog.getByLabelText('Sector'), ' (invented)');
    await user.click(dialog.getByRole('button', { name: 'Save classification' }));
    expect(await about.findByText('Edited by you')).toBeInTheDocument();
    expect(about.getByText('Sector').nextElementSibling).toHaveTextContent('Technology (invented)');
  });

  it('keeps showing the public profile, without the edit control, when the override list cannot be loaded', async () => {
    server.use(http.get(api('/classification'), () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 })));
    const { about } = await openAsset('/assets/AAPL?portfolio=all');
    expect(about.getByText('Sector').nextElementSibling).toHaveTextContent('Technology');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Apple Inc.' })).toBeInTheDocument());
    expect(about.queryByRole('button', { name: 'Edit classification' })).not.toBeInTheDocument();
  });
});
