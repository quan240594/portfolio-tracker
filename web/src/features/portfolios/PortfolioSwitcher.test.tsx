import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { gotoViaNav, renderApp, renderWithProviders } from '../../test/utils';
import { server } from '../../mocks/server';
import { getPortfolio } from '../../mocks/db';
import { PORTFOLIO_STORAGE_KEY, defaultTargetPortfolio, readStoredScope, usePortfolioScope } from './usePortfolioScope';
import type { Portfolio } from '@portfolio/shared';

const switcher = () => screen.getByRole('combobox', { name: 'Portfolio' });
// Menu links are hidden while the Portfolio menu is closed; only their hrefs are inspected here.
const navLink = (name: string) => within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name, hidden: true });
const optionsOf = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent);

/** Records the `portfolioId` query param of every analytics request. */
function trackScopes() {
  const seen: { path: string; portfolioId: string | null }[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname !== '/api/portfolios') seen.push({ path: url.pathname, portfolioId: url.searchParams.get('portfolioId') });
  });
  return seen;
}

afterEach(() => server.events.removeAllListeners());

describe('PortfolioSwitcher', () => {
  it('defaults to all portfolios, lists every portfolio and keeps plain nav links', async () => {
    const seen = trackScopes();
    renderApp('/');
    expect(switcher()).toHaveValue('all');
    await waitFor(() => expect(optionsOf(switcher())).toEqual(['All portfolios', 'Main portfolio', 'Trading 212']));
    expect(navLink('Holdings')).toHaveAttribute('href', '/holdings');
    expect(await screen.findByText(/^All portfolios · values in EUR/)).toBeInTheDocument();
    // The combined view omits ?portfolioId.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.portfolioId === null)).toBe(true);
  });

  it('switches scope via the URL, persists it and keeps it on nav links', async () => {
    const user = userEvent.setup();
    const seen = trackScopes();
    const { router } = renderApp('/');
    await screen.findByRole('option', { name: 'Trading 212' });

    await user.selectOptions(switcher(), 'Trading 212');
    expect(router.state.location.search).toBe('?portfolio=trading-212');
    expect(localStorage.getItem(PORTFOLIO_STORAGE_KEY)).toBe('trading-212');
    expect(switcher()).toHaveValue('trading-212');
    expect(navLink('Holdings')).toHaveAttribute('href', '/holdings?portfolio=trading-212');
    expect(await screen.findByText(/^Trading 212 · values in EUR/)).toBeInTheDocument();
    await waitFor(() => expect(seen.some((s) => s.path === '/api/portfolio' && s.portfolioId === 'trading-212')).toBe(true));

    await gotoViaNav(user, 'Holdings');
    expect(router.state.location.pathname).toBe('/holdings');
    expect(router.state.location.search).toBe('?portfolio=trading-212');
    expect(await screen.findByText(/^Trading 212 · 4 positions/)).toBeInTheDocument();

    // Explicitly choosing "All portfolios" keeps an explicit param so history stays unambiguous.
    await user.selectOptions(switcher(), 'All portfolios');
    expect(router.state.location.search).toBe('?portfolio=all');
    expect(localStorage.getItem(PORTFOLIO_STORAGE_KEY)).toBe('all');
    expect(navLink('Dividends')).toHaveAttribute('href', '/dividends?portfolio=all');
    expect(await screen.findByText(/^All portfolios · 12 positions/)).toBeInTheDocument();

    // The back button restores the previous scope.
    await act(() => router.navigate(-1));
    expect(router.state.location.search).toBe('?portfolio=trading-212');
    expect(switcher()).toHaveValue('trading-212');
    expect(await screen.findByText(/^Trading 212 · 4 positions/)).toBeInTheDocument();
  });

  it('reads the scope from the URL on first load', async () => {
    renderApp('/dividends?portfolio=trading-212');
    expect(switcher()).toHaveValue('trading-212');
    expect(await screen.findByText(/^Trading 212 · amounts in EUR/)).toBeInTheDocument();
    expect(localStorage.getItem(PORTFOLIO_STORAGE_KEY)).toBe('trading-212');
  });

  it('falls back to the stored scope and mirrors it into the URL', async () => {
    localStorage.setItem(PORTFOLIO_STORAGE_KEY, 'trading-212');
    const { router } = renderApp('/');
    await waitFor(() => expect(router.state.location.search).toBe('?portfolio=trading-212'));
    expect(switcher()).toHaveValue('trading-212');
    const summary = getPortfolio('trading-212');
    expect(await screen.findByText(new RegExp(`^${summary.holdingsCount} holdings`))).toBeInTheDocument();
  });

  it('falls back to all portfolios when the URL points at a portfolio that no longer exists', async () => {
    localStorage.setItem(PORTFOLIO_STORAGE_KEY, 'trading-212');
    const seen = trackScopes();
    const { router } = renderApp('/holdings?portfolio=deleted-one');
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(switcher()).toHaveValue('all');
    expect(localStorage.getItem(PORTFOLIO_STORAGE_KEY)).toBe('all');
    expect(await screen.findByText(/^All portfolios · 12 positions/)).toBeInTheDocument();
    // The unknown id is never queried.
    expect(seen.some((s) => s.portfolioId === 'deleted-one')).toBe(false);
  });

  it('ignores a malformed URL param and an unknown stored id', async () => {
    localStorage.setItem(PORTFOLIO_STORAGE_KEY, 'gone');
    const { router } = renderApp('/?portfolio=Not%20Valid');
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(switcher()).toHaveValue('all');
    await waitFor(() => expect(localStorage.getItem(PORTFOLIO_STORAGE_KEY)).toBe('all'));
  });

  it('shows a placeholder option while the portfolio list loads', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get('/api/portfolios', async () => {
        await gate;
        return HttpResponse.json({ portfolios: [] });
      }),
    );
    const seen = trackScopes();
    renderApp('/?portfolio=trading-212');
    expect(switcher()).toHaveValue('trading-212');
    expect(within(switcher()).getByRole('option', { name: 'Loading…' })).toBeInTheDocument();
    // Scoped analytics wait until the portfolio is known to exist.
    expect(seen.filter((s) => s.portfolioId === 'trading-212')).toEqual([]);
    release();
    await waitFor(() => expect(switcher()).toHaveValue('all'));
  });

  it('still queries the selected portfolio when the portfolio list cannot be loaded', async () => {
    server.use(http.get('/api/portfolios', () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'down' } }, { status: 500 })));
    const seen = trackScopes();
    renderApp('/holdings?portfolio=trading-212');
    expect(await screen.findByText(/^4 positions/)).toBeInTheDocument();
    expect(seen.some((s) => s.path === '/api/holdings' && s.portfolioId === 'trading-212')).toBe(true);
  });

  it('survives unavailable localStorage', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readStoredScope()).toBeNull();
    const { router } = renderApp('/');
    await screen.findByRole('option', { name: 'Trading 212' });
    await user.selectOptions(switcher(), 'Trading 212');
    expect(router.state.location.search).toBe('?portfolio=trading-212');
  });
});

describe('usePortfolioScope', () => {
  function Probe({ to }: { to: string }) {
    const { scope, scopeName, withScope } = usePortfolioScope();
    return (
      <p>
        {scope}|{scopeName}|{withScope(to)}
      </p>
    );
  }

  it('appends the scope to links, also to links that already have a query', async () => {
    renderWithProviders(<Probe to="/transactions?action=add" />, { route: '/?portfolio=trading-212' });
    expect(await screen.findByText('trading-212|Trading 212|/transactions?action=add&portfolio=trading-212')).toBeInTheDocument();
  });

  it('leaves links alone for the implicit combined view', () => {
    renderWithProviders(<Probe to="/holdings" />);
    expect(screen.getByText('all|All portfolios|/holdings')).toBeInTheDocument();
  });
});

describe('defaultTargetPortfolio', () => {
  const p = (portfolioId: string): Portfolio => ({ portfolioId, userId: 'u', name: portfolioId, createdAt: '', updatedAt: '' });

  it('prefers the scoped portfolio, then the default, then the first one', () => {
    expect(defaultTargetPortfolio('all', undefined)).toBe('default');
    expect(defaultTargetPortfolio('p1', undefined)).toBe('p1');
    expect(defaultTargetPortfolio('p1', [p('default'), p('p1')])).toBe('p1');
    expect(defaultTargetPortfolio('all', [p('p2'), p('default')])).toBe('default');
    expect(defaultTargetPortfolio('gone', [p('p2'), p('p3')])).toBe('p2');
    expect(defaultTargetPortfolio('all', [])).toBe('default');
  });
});
