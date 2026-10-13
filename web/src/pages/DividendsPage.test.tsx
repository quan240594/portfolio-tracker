import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { GetDividendsResponse } from '@portfolio/shared';
import { DividendsPage } from './DividendsPage';
import { renderApp, renderWithProviders, sp } from '../test/utils';
import { server } from '../mocks/server';
import { getDividends } from '../mocks/db';
import { formatDate, formatMoney } from '../lib/format';

const overview = (over: Partial<GetDividendsResponse> = {}): GetDividendsResponse => ({ ...getDividends(), ...over });

describe('DividendsPage', () => {
  it('shows loading placeholders, then KPIs, chart, upcoming and received payments', async () => {
    const data = getDividends();
    renderWithProviders(<DividendsPage />);
    expect(screen.getByRole('region', { name: 'Total received' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading chart')).toBeInTheDocument();

    const total = await screen.findByRole('region', { name: 'Total received' });
    expect(await within(total).findByText(sp(formatMoney(data.totalReceived, 'EUR')))).toBeInTheDocument();
    expect(within(total).getByText('All time')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Last 12 months' })).getByText(sp(formatMoney(data.last12Months, 'EUR')))).toBeInTheDocument();
    const projected = screen.getByRole('region', { name: 'Projected next 12 months' });
    expect(within(projected).getByText(sp(`≈ ${formatMoney(data.projectedNext12Months / 12, 'EUR')} per month`))).toBeInTheDocument();

    expect(screen.getByRole('img', { name: /^Monthly dividends across \d+ months/ })).toBeInTheDocument();

    const upcoming = within(screen.getByRole('region', { name: 'Upcoming' })).getAllByRole('listitem');
    expect(upcoming).toHaveLength(data.upcoming.length);
    const first = data.upcoming[0]!;
    expect(upcoming[0]).toHaveTextContent(first.symbol);
    expect(upcoming[0]).toHaveTextContent(`pays ${formatDate(first.date)}`);
    expect(upcoming[0]).toHaveTextContent(sp(formatMoney(first.amount, 'EUR')));
    expect(upcoming[0]).toHaveTextContent(sp(`${formatMoney(first.perShareLocal, first.currency, { maxDigits: 4 })} per share`));

    const table = within(screen.getByRole('region', { name: 'Received' })).getByRole('table', { name: 'Received dividends, newest first' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(data.received.length);
    const newest = data.received.at(-1)!;
    expect(rows[0]).toHaveTextContent(formatDate(newest.date));
    expect(rows[0]).toHaveTextContent(newest.symbol);
    expect(rows[0]).toHaveTextContent(sp(formatMoney(newest.amount, 'EUR')));

    // Per-share amounts stay in the paying currency; amounts are converted to EUR.
    expect(within(table).getByRole('columnheader', { name: 'Amount (EUR)' })).toBeInTheDocument();
    const usd = [...data.received].reverse().findIndex((p) => p.currency === 'USD');
    const usdPayment = [...data.received].reverse()[usd]!;
    const usdCells = within(rows[usd]!).getAllByRole('cell');
    expect(usdCells[2]).toHaveTextContent(sp(formatMoney(usdPayment.perShareLocal, 'USD', { maxDigits: 4 })));
    expect(usdCells[2]).toHaveTextContent(/^US\$/);
    expect(usdCells[3]).toHaveTextContent(new RegExp(`^${sp(formatMoney(usdPayment.amount, 'EUR'))}$`));
  });

  it('shows an error and retries', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/dividends', () => new HttpResponse('upstream exploded', { status: 503, statusText: 'Service Unavailable' }), { once: true }));
    renderWithProviders(<DividendsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load dividends');
    expect(alert).toHaveTextContent('Service Unavailable');

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Received dividends, newest first' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no dividends at all', async () => {
    server.use(http.get('/api/dividends', () => HttpResponse.json(overview({ received: [], upcoming: [], monthly: [], totalReceived: 0, last12Months: 0, projectedNext12Months: 0 }))));
    renderWithProviders(<DividendsPage />);
    expect(await screen.findByRole('heading', { name: 'No dividends yet' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('handles no upcoming and no received dividends separately', async () => {
    server.use(http.get('/api/dividends', () => HttpResponse.json(overview({ upcoming: [] })), { once: true }));
    const { unmount } = renderWithProviders(<DividendsPage />);
    expect(await screen.findByText('No announced dividends for your current holdings.')).toBeInTheDocument();
    unmount();

    server.use(http.get('/api/dividends', () => HttpResponse.json(overview({ received: [] }))));
    renderWithProviders(<DividendsPage />);
    expect(await screen.findByText('No dividends received yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('is reachable from the router', async () => {
    renderApp('/dividends');
    expect(await screen.findByRole('heading', { level: 1, name: 'Dividends' })).toBeInTheDocument();
    expect(
      screen.getByText('All portfolios · amounts in EUR (per-share amounts in the paying currency). Received amounts are net of withholding tax; upcoming amounts are gross estimates.'),
    ).toBeInTheDocument();
  });
});
