import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';

const cardIds = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset.cardId!);
const headerActions = () => document.querySelector<HTMLElement>('[data-page-header-actions]')!;
const customize = (user: ReturnType<typeof userEvent.setup>) => user.click(within(headerActions()).getByRole('button', { name: 'Customize layout' }));

async function openAsset(path: string, expected: string[]) {
  const user = userEvent.setup();
  renderApp(path);
  await screen.findByRole('heading', { level: 1, name: 'Apple Inc.' });
  await waitFor(() => expect(cardIds()).toEqual(expected));
  return user;
}

describe('Asset detail tabs as customizable card grids', () => {
  it('overview: keeps the order, shows the toggle in the header card and customizes it', async () => {
    const user = await openAsset('/assets/AAPL?portfolio=all', ['price-history', 'stats', 'latest-earnings', 'positions', 'about']);
    expect(within(screen.getByRole('region', { name: 'Apple Inc. overview' })).getByRole('button', { name: 'Customize layout' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Benchmarks' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Key figures' })).toBeInTheDocument();
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Move Key figures down' }));
    expect(cardIds()).toEqual(['price-history', 'latest-earnings', 'stats', 'positions', 'about']);
    await user.click(screen.getByRole('button', { name: 'Hide Price history' }));
    expect(cardIds()).toEqual(['latest-earnings', 'stats', 'positions', 'about']);
    expect(screen.queryByRole('region', { name: 'Benchmarks' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Key figures' })).toBeInTheDocument();
  });

  it('dividends: keeps the order and customizes it', async () => {
    const user = await openAsset('/assets/AAPL?portfolio=all&tab=dividends', ['div-kpis', 'div-per-year', 'div-history', 'div-received']);
    expect(within(headerActions()).getByRole('button', { name: 'Customize layout' })).toBeInTheDocument();
    expect(screen.getByLabelText('Dividend figures')).toBeInTheDocument();
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Move Dividend history up' }));
    expect(cardIds()).toEqual(['div-kpis', 'div-history', 'div-per-year', 'div-received']);
    await user.click(screen.getByRole('button', { name: 'Hide Dividends you received' }));
    expect(cardIds()).toEqual(['div-kpis', 'div-history', 'div-per-year']);
    expect(screen.queryByRole('region', { name: 'Dividends you received' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Dividend history' })).toBeInTheDocument();
  });
});
