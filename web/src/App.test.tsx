import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, createQueryClient, titleFor } from './App';
import { ApiError } from './api/client';
import { gotoViaNav, mainNav, renderApp } from './test/utils';

describe('App routing', () => {
  it('renders the 404 page for unknown routes with a link back to the dashboard', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/does/not/exist');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText('The page you are looking for does not exist.')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Not found · Portfolio Tracker'));

    await user.click(screen.getByRole('link', { name: 'Back to dashboard' }));
    expect(router.state.location.pathname).toBe('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(document.title).toBe('Dashboard · Portfolio Tracker');
  });

  it('navigates via the main nav, marks the active link, updates the title and moves focus to <main>', async () => {
    const user = userEvent.setup();
    renderApp('/');
    const nav = mainNav();
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('main')).not.toHaveFocus();

    for (const [label, title] of [
      ['Holdings', 'Holdings'],
      ['Dividends', 'Dividends'],
      ['Transactions', 'Transactions'],
      ['Dashboard', 'Dashboard'],
    ] as const) {
      await gotoViaNav(user, label);
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      expect(within(nav).getByRole('link', { name: label, hidden: true })).toHaveAttribute('aria-current', 'page');
      expect(document.title).toBe(`${title} · Portfolio Tracker`);
      expect(screen.getByRole('main')).toHaveFocus();
    }
  });

  it('provides a skip link and the market-data attribution footer', () => {
    renderApp('/');
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent('Market data: Twelve Data, EODHD, CoinGecko, ECB via Frankfurter.');
    expect(footer).toHaveTextContent('Not investment advice.');
    const link = within(footer).getByRole('link', { name: 'CoinGecko' });
    expect(link).toHaveAttribute('href', 'https://www.coingecko.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('complementary', { name: 'Demo mode' })).not.toBeInTheDocument();
  });

  it('toggles dark mode from the header and persists it', async () => {
    const user = userEvent.setup();
    renderApp('/');
    const toggle = screen.getByRole('button', { name: 'Dark mode' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('title', 'Switch to dark theme');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveAttribute('title', 'Switch to light theme');
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('pt-theme')).toBe('dark');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(localStorage.getItem('pt-theme')).toBe('light');
  });

  it('works under a sub-path basename (GitHub Pages): links, active state, title', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/portfolio-tracker/holdings', { basename: '/portfolio-tracker' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Holdings' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Holdings · Portfolio Tracker'));

    const nav = mainNav();
    expect(within(nav).getByRole('link', { name: 'Holdings', hidden: true })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Holdings', hidden: true })).toHaveAttribute('href', '/portfolio-tracker/holdings');
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/portfolio-tracker');
    expect(screen.getByRole('link', { name: 'Portfolio Tracker' })).toHaveAttribute('href', '/portfolio-tracker');

    await gotoViaNav(user, 'Transactions');
    expect(await screen.findByRole('heading', { level: 1, name: 'Transactions' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/portfolio-tracker/transactions');
    expect(document.title).toBe('Transactions · Portfolio Tracker');
  });

  it('boots the real App with a browser router at "/"', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Total value' })).toBeInTheDocument();
  });
});

describe('createQueryClient', () => {
  const retry = createQueryClient().getDefaultOptions().queries!.retry as (count: number, err: unknown) => boolean;

  it('never retries client errors (4xx)', () => {
    expect(retry(0, new ApiError(400, 'VALIDATION_ERROR', 'bad'))).toBe(false);
    expect(retry(0, new ApiError(404, 'NOT_FOUND', 'missing'))).toBe(false);
  });

  it('retries server/network errors at most twice', () => {
    expect(retry(0, new ApiError(500, 'INTERNAL', 'boom'))).toBe(true);
    expect(retry(1, new ApiError(0, 'NETWORK_ERROR', 'offline'))).toBe(true);
    expect(retry(2, new ApiError(503, 'HTTP_503', 'unavailable'))).toBe(false);
    expect(retry(0, new Error('unknown'))).toBe(true);
  });

  it('disables refetch on focus and caches for 30s', () => {
    const q = createQueryClient().getDefaultOptions().queries!;
    expect(q.refetchOnWindowFocus).toBe(false);
    expect(q.staleTime).toBe(30_000);
  });
});

describe('titleFor', () => {
  it('maps known routes, asset detail pages and unknown paths', () => {
    expect(titleFor('/assets')).toBe('Assets');
    expect(titleFor('/assets/ASML.AS')).toBe('ASML.AS · Asset detail');
    expect(titleFor('/assets/BTC%2DEUR')).toBe('BTC-EUR · Asset detail');
    expect(titleFor('/assets/%E0%A4%A')).toBe('Asset detail');
    expect(titleFor('/assets/')).toBe('Not found');
    expect(titleFor('/nope')).toBe('Not found');
  });
});
