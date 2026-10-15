import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { invalidatePortfolioData } from '../../api/hooks';
import { addTransaction, getHoldings, resetDb } from '../../mocks/db';
import { server } from '../../mocks/server';
import { renderApp, sp } from '../../test/utils';
import { formatMoney } from '../../lib/format';

const serverError = () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 });

async function openSecurities(path = '/assets?portfolio=all') {
  const user = userEvent.setup();
  const app = renderApp(path);
  const table = await screen.findByRole('table', { name: /^Securities in your portfolio/ });
  return { user, table, ...app };
}

const symbolsIn = (table: HTMLElement) => within(table).getAllByRole('rowheader').map((r) => r.querySelector('a')!.textContent);

describe('Securities in your portfolio', () => {
  it('lists the market securities of the combined scope, linked to their detail page', async () => {
    const { table } = await openSecurities();
    const { holdings } = getHoldings();
    const market = holdings.filter((h) => !h.symbol.startsWith('CASH.') && !h.symbol.startsWith('CUSTOM:'));
    expect(within(table).getAllByRole('rowheader')).toHaveLength(market.length);
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent?.replace(/[▲▼]/g, ''))).toEqual(['Security', 'Sector', 'Country', 'Currency', 'Shares', 'Value (EUR)', 'P/L %', 'Weight']);
    const aapl = within(table).getByRole('link', { name: 'AAPL' });
    expect(aapl).toHaveAttribute('href', '/assets/AAPL?portfolio=all');
    const row = aapl.closest('tr')!;
    const h = market.find((x) => x.symbol === 'AAPL')!;
    expect(within(row).getByText('Apple Inc.')).toBeInTheDocument();
    expect(within(row).getByText('Technology')).toBeInTheDocument();
    expect(within(row).getByText('United States')).toBeInTheDocument();
    expect(within(row).getByText('USD')).toBeInTheDocument();
    expect(row).toHaveTextContent(sp(formatMoney(h.marketValue)));
    expect(screen.getByRole('status')).toHaveTextContent(`${market.length} of ${market.length} securities`);
    expect(screen.getByRole('heading', { name: 'Custom assets' })).toBeInTheDocument();
  });

  it('encodes symbols such as BTC-EUR and ASML.AS in the link and keeps the scope', async () => {
    const { table } = await openSecurities('/assets?portfolio=default');
    expect(within(table).getByRole('link', { name: 'ASML.AS' })).toHaveAttribute('href', '/assets/ASML.AS?portfolio=default');
    expect(within(table).getByRole('link', { name: 'BTC-EUR' })).toHaveAttribute('href', '/assets/BTC-EUR?portfolio=default');
    expect(within(table).queryByRole('link', { name: 'AAPL' })).not.toBeInTheDocument();
  });

  it('follows the portfolio scope', async () => {
    const { table } = await openSecurities('/assets?portfolio=trading-212');
    expect(symbolsIn(table).slice().sort((a, b) => a!.localeCompare(b!))).toEqual(['AAPL', 'JNJ', 'KO', 'MSFT']);
    expect(screen.getByText(/Showing Trading 212\./)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('4 of 4 securities');
  });

  it('searches on ticker, name, sector and country', async () => {
    const { user, table } = await openSecurities();
    const search = screen.getByRole('searchbox', { name: 'Search securities' });
    await user.type(search, 'technology');
    expect(symbolsIn(table).slice().sort((a, b) => a!.localeCompare(b!))).toEqual(['AAPL', 'ASML.AS', 'MSFT']);
    expect(screen.getByRole('status')).toHaveTextContent('3 of 8 securities');
    await user.clear(search);
    await user.type(search, 'coca');
    expect(symbolsIn(table)).toEqual(['KO']);
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No securities match “zzz”.')).toBeInTheDocument();
  });

  it('sorts by clicking a header and by the select on small screens', async () => {
    const { user, table } = await openSecurities();
    const valueHeader = within(table).getByRole('columnheader', { name: /Value \(EUR\)/ });
    expect(valueHeader).toHaveAttribute('aria-sort', 'descending');
    const firstByValue = symbolsIn(table)[0];
    await user.click(within(table).getByRole('button', { name: /^Security/ }));
    expect(within(table).getByRole('columnheader', { name: /Security/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(symbolsIn(table)).toEqual(symbolsIn(table).slice().sort((a, b) => a!.localeCompare(b!)));
    await user.click(within(table).getByRole('button', { name: /^Security/ }));
    expect(within(table).getByRole('columnheader', { name: /Security/ })).toHaveAttribute('aria-sort', 'descending');
    expect(symbolsIn(table)[0]).toBe('VWRL.AS');
    await user.click(within(table).getByRole('button', { name: /Value \(EUR\)/ }));
    expect(symbolsIn(table)[0]).toBe(firstByValue);
    await user.click(within(table).getByRole('button', { name: /^Country/ }));
    expect(within(table).getByRole('columnheader', { name: /Country/ })).toHaveAttribute('aria-sort', 'ascending');

    await user.selectOptions(screen.getByLabelText('Sort by'), 'weight:asc');
    expect(within(table).getByRole('columnheader', { name: /Weight/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(within(table).getByRole('columnheader', { name: /Weight/ })).toBeInTheDocument();
  });

  it('shows the same securities as cards for small screens', async () => {
    await openSecurities();
    const cards = screen.getByRole('list', { name: 'Securities in your portfolio' });
    expect(within(cards).getAllByRole('listitem')).toHaveLength(8);
    expect(within(cards).getByRole('link', { name: 'BTC-EUR' })).toHaveAttribute('href', '/assets/BTC-EUR?portfolio=all');
  });

  it('includes sold positions on request, marked as sold out and without a value', async () => {
    addTransaction({ portfolioId: 'trading-212', date: '2026-09-01', type: 'SELL', symbol: 'KO', quantity: 60, price: 70, fee: 0, currency: 'USD' });
    const { user, table } = await openSecurities();
    expect(symbolsIn(table)).not.toContain('KO');
    const toggle = screen.getByRole('checkbox', { name: 'Include sold positions' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(symbolsIn(table)).toContain('KO'));
    const row = within(table).getByRole('link', { name: 'KO' }).closest('tr')!;
    expect(within(row).getByText('Sold out')).toBeInTheDocument();
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('status')).toHaveTextContent('8 of 8 securities');
    await user.click(toggle);
    await waitFor(() => expect(symbolsIn(table)).not.toContain('KO'));
  });

  it('updates by itself when transactions change, for open and sold positions', async () => {
    const { user, table, queryClient } = await openSecurities('/assets?portfolio=trading-212');
    await user.click(screen.getByRole('checkbox', { name: 'Include sold positions' }));
    expect(symbolsIn(table)).not.toContain('NVDA');

    addTransaction({ portfolioId: 'trading-212', date: '2026-10-01', type: 'BUY', symbol: 'NVDA', quantity: 3, price: 130, fee: 0, currency: 'USD' });
    addTransaction({ portfolioId: 'trading-212', date: '2026-10-02', type: 'SELL', symbol: 'KO', quantity: 60, price: 70, fee: 0, currency: 'USD' });
    await act(async () => {
      await invalidatePortfolioData(queryClient, 'trading-212');
    });
    await waitFor(() => expect(symbolsIn(table)).toContain('NVDA'));
    await waitFor(() => expect(within(within(table).getByRole('link', { name: 'KO' }).closest('tr')!).getByText('Sold out')).toBeInTheDocument());
  });

  it('shows an empty state with a way to add a transaction', async () => {
    resetDb({ empty: true });
    renderApp('/assets?portfolio=default');
    expect(await screen.findByRole('heading', { name: 'No securities yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a transaction' })).toHaveAttribute('href', '/transactions?portfolio=default');
  });

  it('shows a loading region first', async () => {
    renderApp('/assets?portfolio=all');
    expect(await screen.findByText('Loading securities')).toBeInTheDocument();
    await screen.findByRole('table', { name: /^Securities in your portfolio/ });
  });

  it('reports failures and retries', async () => {
    let fail = true;
    server.use(http.get('/api/holdings', () => (fail ? serverError() : HttpResponse.json({ baseCurrency: 'EUR', holdings: [] }))));
    const user = userEvent.setup();
    renderApp('/assets?portfolio=all');
    expect(await screen.findByText('Could not load your securities')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'No securities yet' })).toBeInTheDocument();
  });

  it('keeps the open securities when the sold positions cannot be loaded', async () => {
    server.use(http.get('/api/securities/closed', serverError));
    const { user, table } = await openSecurities();
    await user.click(screen.getByRole('checkbox', { name: 'Include sold positions' }));
    expect(await screen.findByText('Could not load your sold positions.')).toBeInTheDocument();
    expect(within(table).getAllByRole('rowheader')).toHaveLength(8);
  });
});
