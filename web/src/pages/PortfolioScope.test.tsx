import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { computeDividendsOverview } from '@portfolio/shared';
import { renderApp } from '../test/utils';
import { server } from '../mocks/server';
import { createPortfolio, getAnalyticsData, getDividends, getHoldings, listTransactions } from '../mocks/db';
import { formatMoney } from '../lib/format';
import { sp } from '../test/utils';

afterEach(() => server.events.removeAllListeners());

const txTable = () => screen.findByRole('table', { name: 'Transactions, newest first' });
const bodyRows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);

describe('portfolio-scoped pages', () => {
  it('scopes every dashboard query to the selected portfolio', async () => {
    const params: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      // The watchlist is per user, not per portfolio.
      if (url.pathname !== '/api/portfolios' && url.pathname !== '/api/watchlist') params.push(`${url.pathname}?${url.searchParams.get('portfolioId')}`);
    });
    renderApp('/?portfolio=trading-212');
    const top = await screen.findByRole('region', { name: 'Top holdings' });
    const items = await within(top).findAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(within(top).getByRole('link', { name: 'View all →' })).toHaveAttribute('href', '/holdings?portfolio=trading-212');
    await waitFor(() =>
      expect(new Set(params)).toEqual(
        new Set([
          '/api/portfolio?trading-212',
          '/api/holdings?trading-212',
          '/api/allocation?trading-212',
          '/api/history?trading-212',
          '/api/analytics/summary?trading-212',
        ]),
      ),
    );
  });

  it('shows only the scoped holdings and dividends', async () => {
    const user = userEvent.setup();
    const { holdings } = getHoldings('trading-212');
    const total = holdings.reduce((s, h) => s + h.marketValue, 0);
    renderApp('/holdings?portfolio=trading-212');
    expect(await screen.findByText(sp(`Trading 212 · 4 positions · ${formatMoney(total, 'EUR')} · all amounts in EUR`))).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getAllByRole('rowheader').map((r) => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('AAPL'), expect.stringContaining('JNJ')]),
    );
    expect(screen.queryByRole('rowheader', { name: /VWRL/ })).not.toBeInTheDocument();

    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Dividends' }));
    const income = await screen.findByRole('region', { name: 'Dividends' });
    expect(await within(income).findByTestId('kpi-income')).toHaveTextContent(sp(formatMoney(computeDividendsOverview(getAnalyticsData('trading-212')).summary.forward12m, 'EUR')));
    expect(await screen.findByTestId('received-total')).toHaveTextContent(sp(formatMoney(getDividends('trading-212').received.reduce((s, p) => s + p.amount, 0), 'EUR')));
  });

  it('shows empty states naming an empty portfolio, with links that keep the scope', async () => {
    const user = userEvent.setup();
    const p = createPortfolio('Pension');
    renderApp(`/?portfolio=${p.portfolioId}`);
    expect(await screen.findByRole('heading', { name: 'No transactions in Pension yet' })).toBeInTheDocument();
    expect(screen.getByText(/^Pension · values in EUR/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add transaction' })).toHaveAttribute('href', `/transactions?action=add&portfolio=${p.portfolioId}`);
    expect(screen.getByRole('link', { name: 'Import CSV' })).toHaveAttribute('href', `/transactions?action=import&portfolio=${p.portfolioId}`);

    const nav = screen.getByRole('navigation', { name: 'Main' });
    await user.click(within(nav).getByRole('link', { name: 'Holdings' }));
    expect(await screen.findByRole('heading', { name: 'No open positions in Pension' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add transaction' })).toHaveAttribute('href', `/transactions?action=add&portfolio=${p.portfolioId}`);

    await user.click(within(nav).getByRole('link', { name: 'Dividends' }));
    expect(await screen.findByRole('heading', { name: 'No dividends in Pension yet' })).toBeInTheDocument();
    expect(screen.getByText(/^Pension · amounts in EUR/)).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'Transactions' }));
    expect(await screen.findByRole('heading', { name: 'No transactions in Pension yet' })).toBeInTheDocument();
    expect(screen.getByText(/^Pension · buys, sells and dividends/)).toBeInTheDocument();
  });

  it('shows a Portfolio column only in the combined transaction list', async () => {
    const user = userEvent.setup();
    renderApp('/transactions');
    let table = await txTable();
    expect(within(table).getByRole('columnheader', { name: 'Portfolio' })).toBeInTheDocument();
    const all = listTransactions();
    const first = bodyRows(table)[0]!;
    expect(first).toHaveTextContent(all[0]!.portfolioId === 'default' ? 'Main portfolio' : 'Trading 212');
    expect(screen.getByText(/^All portfolios · buys, sells and dividends/)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Portfolio' }), 'Trading 212');
    await waitFor(() => expect(bodyRows(screen.getByRole('table'))).toHaveLength(listTransactions('trading-212').length));
    table = screen.getByRole('table');
    expect(within(table).queryByRole('columnheader', { name: 'Portfolio' })).not.toBeInTheDocument();
    expect(table).not.toHaveTextContent('VWRL.AS');
  });

  it('deleting a scoped transaction refreshes that portfolio', async () => {
    const user = userEvent.setup();
    const before = listTransactions('trading-212');
    const target = before[0]!;
    renderApp('/transactions?portfolio=trading-212');
    const table = await txTable();
    await user.click(within(bodyRows(table)[0]!).getByRole('button', { name: /^Delete/ }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(bodyRows(screen.getByRole('table'))).toHaveLength(before.length - 1));
    expect(listTransactions('trading-212').some((t) => t.id === target.id)).toBe(false);
  });

  it('adds to another portfolio from a scoped list and says where it went', async () => {
    const user = userEvent.setup();
    renderApp('/transactions?portfolio=default&action=add');
    const dialog = await screen.findByRole('dialog', { name: 'Add transaction' });
    const select = within(dialog).getByLabelText('Portfolio');
    await waitFor(() => expect(select).toHaveValue('default'));
    await user.selectOptions(select, 'Trading 212');
    await user.type(within(dialog).getByLabelText('Symbol'), 'NVDA');
    await user.clear(within(dialog).getByLabelText('Currency'));
    await user.type(within(dialog).getByLabelText('Currency'), 'USD');
    await user.type(within(dialog).getByLabelText('Quantity'), '2');
    await user.type(within(dialog).getByLabelText('Price per unit'), '120');
    await user.click(within(dialog).getByRole('button', { name: 'Save transaction' }));

    expect(await screen.findByText('Added buy of 2 NVDA to Trading 212 (switch portfolio to see it).')).toBeInTheDocument();
    expect(listTransactions('trading-212').some((t) => t.symbol === 'NVDA')).toBe(true);
    expect(screen.getByRole('table')).not.toHaveTextContent('NVDA');
  });
});
