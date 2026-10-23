import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EARNINGS_ITEM, MainNav, PORTFOLIO_ITEMS } from './MainNav';
import { gotoViaNav, mainNav, openPortfolioMenu, renderApp, renderWithProviders } from '../test/utils';

const trigger = () => within(mainNav()).getByRole('button', { name: 'Portfolio' });
const menuLinks = () => within(mainNav()).queryAllByRole('link', { name: (name) => PORTFOLIO_ITEMS.some((i) => i.label === name) });

describe('main navigation', () => {
  it('groups the pages: Dashboard, Portfolio menu, Analytics', () => {
    renderApp('/');
    const nav = mainNav();
    const top = within(nav).getAllByRole('listitem').filter((li) => li.parentElement === nav.querySelector('ul'));
    expect(top.map((li) => li.querySelector('a, button')?.textContent)).toEqual(['Dashboard', 'Portfolio', 'Analytics']);
    expect(within(nav).getByRole('link', { name: 'Analytics' })).toHaveAttribute('href', '/analytics');
  });

  it('keeps the menu closed by default, as a native disclosure (no ARIA menu roles)', () => {
    renderApp('/');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveAttribute('type', 'button');
    expect(trigger()).toHaveAttribute('aria-controls');
    expect(menuLinks()).toHaveLength(0);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    expect(document.getElementById(trigger().getAttribute('aria-controls')!)).toHaveAttribute('hidden');
  });

  it('opens and closes on click, with the links in the documented order', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await user.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(menuLinks().map((l) => l.textContent)).toEqual([
      'Holdings', 'Transactions', 'Dividends', 'Rebalance', 'Assets', 'Watchlist', 'Goals', 'Calendar', 'Brokers',
    ]);
    expect(menuLinks().map((l) => l.getAttribute('href'))).toEqual([
      '/holdings', '/transactions', '/dividends', '/rebalance', '/assets', '/watchlist', '/goals', '/calendar', '/brokers',
    ]);
    await user.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(menuLinks()).toHaveLength(0);
  });

  it('is keyboard operable: Enter and Space toggle, Tab walks the links in order', async () => {
    const user = userEvent.setup();
    renderApp('/');
    act(() => within(mainNav()).getByRole('link', { name: 'Dashboard' }).focus());
    await user.tab();
    expect(trigger()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard(' ');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard(' ');
    for (const label of PORTFOLIO_ITEMS.map((i) => i.label)) {
      await user.tab();
      expect(within(mainNav()).getByRole('link', { name: label })).toHaveFocus();
    }
    await user.tab();
    expect(within(mainNav()).getByRole('link', { name: 'Analytics' })).toHaveFocus();
    // Focus leaving the group closed it.
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    await user.tab({ shift: true });
    expect(trigger()).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await openPortfolioMenu(user);
    within(mainNav()).getByRole('link', { name: 'Assets' }).focus();
    await user.keyboard('{Escape}');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveFocus();
    // Other keys leave it open; Escape with the menu closed is a no-op.
    await openPortfolioMenu(user);
    await user.keyboard('{Shift}');
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes on an outside press and when focus moves outside, not when interacting inside', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await openPortfolioMenu(user);
    await user.click(within(mainNav()).getByRole('link', { name: 'Assets' }).parentElement!);
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('heading', { level: 1 }));
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    await openPortfolioMenu(user);
    act(() => screen.getByRole('link', { name: 'Skip to content' }).focus());
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes after navigating (also to the page already shown) and on history navigation', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/holdings');
    await gotoViaNav(user, 'Holdings');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    await gotoViaNav(user, 'Goals');
    expect(await screen.findByRole('heading', { level: 1, name: 'Goals' })).toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    await openPortfolioMenu(user);
    await act(() => router.navigate('/dividends'));
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the Portfolio trigger as active for every child route, with the child marked current', async () => {
    const user = userEvent.setup();
    renderApp('/');
    expect(trigger()).not.toHaveAttribute('data-active');
    expect(trigger()).not.toHaveAttribute('aria-current');
    for (const { label } of PORTFOLIO_ITEMS) {
      await gotoViaNav(user, label);
      // Lazy routes only become current once their chunk has loaded.
      await waitFor(() => expect(within(mainNav()).getByRole('link', { name: label, hidden: true })).toHaveAttribute('aria-current', 'page'));
      expect(trigger()).toHaveAttribute('data-active', 'true');
      expect(trigger()).not.toHaveAttribute('aria-current');
      expect(trigger().className).toContain('bg-brand-50');
      await openPortfolioMenu(user);
      expect(within(mainNav()).getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page')).toHaveLength(1);
    }
  });

  it('keeps Portfolio active on nested routes such as /assets/:symbol, and not on Dashboard or Analytics', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/assets/AAPL');
    await screen.findByRole('heading', { level: 1, name: 'Apple Inc.' });
    expect(trigger()).toHaveAttribute('data-active', 'true');
    await openPortfolioMenu(user);
    expect(within(mainNav()).getByRole('link', { name: 'Assets' })).toHaveAttribute('aria-current', 'page');

    await act(() => router.navigate('/analytics'));
    await waitFor(() => expect(within(mainNav()).getByRole('link', { name: 'Analytics' })).toHaveAttribute('aria-current', 'page'));
    expect(trigger()).not.toHaveAttribute('data-active');
    await act(() => router.navigate('/'));
    expect(trigger()).not.toHaveAttribute('data-active');
    // A route that merely starts with a child's path is not a child.
    await act(() => router.navigate('/holdings-archive'));
    expect(trigger()).not.toHaveAttribute('data-active');
  });

  it('announces the active section through a description, leaving the trigger name untouched', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/');
    const hint = () => within(mainNav()).queryByText('Current section');
    expect(hint()).not.toBeInTheDocument();
    expect(trigger()).not.toHaveAttribute('aria-describedby');
    expect(trigger()).toHaveAccessibleName('Portfolio');

    await act(() => router.navigate('/holdings'));
    await waitFor(() => expect(trigger()).toHaveAccessibleDescription('Current section'));
    expect(trigger()).toHaveAccessibleName('Portfolio');
    expect(hint()).toHaveClass('sr-only');
    expect(within(mainNav()).getByRole('button', { name: 'Portfolio' })).toBe(trigger());

    await act(() => router.navigate('/assets/AAPL'));
    expect(trigger()).toHaveAccessibleDescription('Current section');
    await openPortfolioMenu(user);
    expect(trigger()).toHaveAccessibleName('Portfolio');

    await act(() => router.navigate('/analytics'));
    expect(hint()).not.toBeInTheDocument();
    expect(trigger()).not.toHaveAttribute('aria-describedby');
    expect(trigger()).toHaveAccessibleDescription('');
    await act(() => router.navigate('/'));
    expect(hint()).not.toBeInTheDocument();
  });

  it('keeps the portfolio scope on menu links', async () => {
    const user = userEvent.setup();
    renderApp('/?portfolio=trading-212');
    await openPortfolioMenu(user);
    expect(within(mainNav()).getByRole('link', { name: 'Holdings' })).toHaveAttribute('href', '/holdings?portfolio=trading-212');
  });

  it('adds Earnings at the end of the menu only when asked to, and marks it as the current section on its pages', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<MainNav withScope={(to) => to} />, { route: '/earnings/LMT' });
    expect(within(mainNav()).getByRole('button', { name: 'Portfolio' })).not.toHaveAttribute('aria-describedby');
    await user.click(trigger());
    expect(within(mainNav()).queryByRole('link', { name: EARNINGS_ITEM.label })).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<MainNav withScope={(to) => to} earnings />, { route: '/earnings/LMT' });
    await user.click(trigger());
    const links = within(mainNav()).getAllByRole('link');
    expect(links.at(-2)).toHaveTextContent('Earnings');
    expect(links.at(-2)).toHaveAttribute('href', '/earnings');
    expect(links.at(-2)).toHaveAttribute('aria-current', 'page');
    expect(trigger()).toHaveAccessibleDescription('Current section');
  });
});
