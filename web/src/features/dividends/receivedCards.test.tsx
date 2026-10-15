import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { AnalyticsDividendGrowthResponse, DividendGrowthStats, GetDividendsResponse } from '@portfolio/shared';
import { computeDividendGrowth } from '@portfolio/shared';
import { renderWithProviders, sp } from '../../test/utils';
import { server } from '../../mocks/server';
import { getAnalyticsData, getDividends } from '../../mocks/db';
import { formatMoney } from '../../lib/format';
import { DividendGrowthCard } from './DividendGrowthCard';
import { growthTiles } from './growthStatsView';
import { ReceivedCards } from './ReceivedCards';

const DIVIDENDS = '/api/dividends';
const respondWith = (data: Partial<GetDividendsResponse>) => server.use(http.get(DIVIDENDS, () => HttpResponse.json({ ...getDividends(), ...data })));
const sum = (payments: { amount: number }[]) => payments.reduce((s, p) => s + p.amount, 0);

describe('ReceivedCards', () => {
  it('shows the total received and the monthly bars, and the totals per holding', async () => {
    const user = userEvent.setup();
    const data = getDividends();
    renderWithProviders(<ReceivedCards />);
    expect(screen.getAllByText('Loading received dividends')).toHaveLength(2);
    const total = await screen.findByTestId('received-total');
    expect(total).toHaveTextContent(sp(formatMoney(sum(data.received), 'EUR')));
    expect(total.parentElement).toHaveTextContent('received all time');
    expect(screen.getByTestId('received-time-chart')).toHaveAccessibleName(/^Dividends received over time: \d+ bars, /);

    const bySymbol = new Map<string, number>();
    for (const p of data.received) bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + p.amount);
    const largest = [...bySymbol.entries()].sort((a, b) => b[1] - a[1])[0]!;
    expect(screen.getByTestId('received-holding-chart')).toHaveAccessibleName(/^Dividends received by holding: \d+ bars, /);
    await user.click(within(screen.getByRole('region', { name: 'Dividends received by holding' })).getByText('Show data table'));
    const rows = within(screen.getByRole('table', { name: 'Dividends received per holding' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(bySymbol.size);
    expect(rows[0]).toHaveTextContent(largest[0]);
    expect(rows[0]).toHaveTextContent(sp(formatMoney(largest[1], 'EUR')));
  });

  it('limits both charts to the selected period', async () => {
    const user = userEvent.setup();
    const data = getDividends();
    const year = new Date().getFullYear();
    renderWithProviders(<ReceivedCards />);
    await screen.findByTestId('received-total');

    await user.click(screen.getByRole('radio', { name: 'YTD' }));
    const ytd = sum(data.received.filter((p) => p.date >= `${year}-01-01`));
    expect(screen.getByTestId('received-total')).toHaveTextContent(sp(formatMoney(ytd, 'EUR')));
    expect(screen.getByTestId('received-total').parentElement).toHaveTextContent('received this year to date');

    await user.click(screen.getByRole('radio', { name: '12 months' }));
    expect(screen.getByTestId('received-total').parentElement).toHaveTextContent('received the last 12 months');
    await user.click(within(screen.getByRole('region', { name: 'Dividends received' })).getByText('Show data table'));
    expect(within(screen.getByRole('table', { name: 'Dividends received per period' })).getAllByRole('row')).toHaveLength(13);
  });

  it('groups by quarter or year', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReceivedCards />);
    await screen.findByTestId('received-total');
    const card = screen.getByRole('region', { name: 'Dividends received' });
    await user.click(within(card).getByText('Show data table'));
    await user.click(screen.getByRole('radio', { name: 'Quarterly' }));
    const cells = within(screen.getByRole('table', { name: 'Dividends received per period' })).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent(/^Q[1-4] \d{2}$/);
    await user.click(screen.getByRole('radio', { name: 'Yearly' }));
    expect(within(screen.getByRole('table', { name: 'Dividends received per period' })).getAllByRole('cell')[0]).toHaveTextContent(/^\d{4}$/);
  });

  it('follows the portfolio scope', async () => {
    renderWithProviders(<ReceivedCards />, { route: '/dividends?portfolio=trading-212' });
    expect(await screen.findByTestId('received-total')).toHaveTextContent(sp(formatMoney(sum(getDividends('trading-212').received), 'EUR')));
  });

  it('shows empty notes without any payments and when the period has none', async () => {
    const user = userEvent.setup();
    respondWith({ received: [], upcoming: [], monthly: [] });
    const first = renderWithProviders(<ReceivedCards />);
    expect(await screen.findByText('No dividends received yet.')).toBeInTheDocument();
    expect(screen.getByText('No dividends received in this period.')).toBeInTheDocument();
    first.unmount();

    respondWith({ received: [{ symbol: 'OLD', date: '2020-01-15', perShareLocal: 1, currency: 'EUR', amount: 12, status: 'RECEIVED' }] });
    renderWithProviders(<ReceivedCards />);
    expect(await screen.findByTestId('received-holding-chart')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'YTD' }));
    expect(screen.getByText('No dividends received in this period.')).toBeInTheDocument();
    expect(screen.getByTestId('received-total')).toHaveTextContent(sp(formatMoney(0, 'EUR')));
  });

  it('shows an error on both cards and retries', async () => {
    const user = userEvent.setup();
    server.use(http.get(DIVIDENDS, () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 }), { once: true }));
    renderWithProviders(<ReceivedCards />);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent('Could not load dividends');
    await user.click(within(alerts[0]!).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('received-time-chart')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('DividendGrowthCard', () => {
  const growth = (): AnalyticsDividendGrowthResponse => computeDividendGrowth(getAnalyticsData());

  it('compares the calendar months of the latest years', async () => {
    const user = userEvent.setup();
    const data = growth();
    renderWithProviders(<DividendGrowthCard />);
    expect(screen.getByText('Loading dividend growth')).toBeInTheDocument();
    const chart = await screen.findByTestId('year-compare-chart');
    const years = [...new Set(data.byMonth.map((m) => m.month.slice(0, 4)))].slice(-3);
    expect(sp(chart.getAttribute('aria-label')!)).toContain(`compared for ${years.join(', ')}.`);
    for (const y of years) expect(chart.getAttribute('aria-label')).toContain(`${y}: `);

    await user.click(screen.getByText('Show data table'));
    const table = screen.getByRole('table', { name: 'Dividends received per calendar month and year' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Month', ...years]);
    expect(within(table).getAllByRole('row')).toHaveLength(13);
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows quarter over quarter, year over year and CAGR under the chart', async () => {
    const user = userEvent.setup();
    const { growthStats } = growth();
    renderWithProviders(<DividendGrowthCard />);
    const stats = await screen.findByTestId('growth-stats');
    const tiles = growthTiles(growthStats!, 'EUR');
    expect(tiles.map((t) => t.id)).toEqual(['qoq', 'yoy', 'cagr']);
    for (const t of tiles) {
      expect(t.value).not.toBe('—');
      const tile = within(stats).getByTestId(`growth-stat-${t.id}`);
      expect(within(tile).getByTestId(`growth-stat-${t.id}-value`)).toHaveTextContent(`${t.arrow}${t.value}`);
      expect(within(tile).getByTestId(`growth-stat-${t.id}-periods`)).toHaveTextContent(t.subtext);
      expect(within(tile).getByText('How is this calculated?')).toBeInTheDocument();
    }
    // directly below the chart, above the data table disclosure
    expect(screen.getByTestId('year-compare-chart').closest('div.overflow-x-auto')!.nextElementSibling).toBe(stats);

    const qoq = within(stats).getByTestId('growth-stat-qoq');
    await user.click(within(qoq).getByText('How is this calculated?'));
    expect(within(qoq).getByText(/latest complete calendar quarter/)).toBeVisible();
  });

  it('shows dashes with the reason when there is not enough history, and no figures from an older server', async () => {
    const empty: DividendGrowthStats = { asOf: '2026-10-15', qoq: null, yoy: null, cagr: null };
    server.use(http.get('/api/analytics/dividend-growth', () => HttpResponse.json({ ...growth(), growthStats: empty })));
    const first = renderWithProviders(<DividendGrowthCard />);
    const stats = await screen.findByTestId('growth-stats');
    expect(within(stats).getAllByText('—')).toHaveLength(3);
    expect(within(stats).getByText('Needs at least 2 years of dividend history.')).toBeInTheDocument();
    first.unmount();

    const { growthStats: _omitted, ...legacy } = growth();
    server.use(http.get('/api/analytics/dividend-growth', () => HttpResponse.json(legacy)));
    renderWithProviders(<DividendGrowthCard />);
    expect(await screen.findByTestId('year-compare-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('growth-stats')).not.toBeInTheDocument();
  });

  it('follows the portfolio scope', async () => {
    renderWithProviders(<DividendGrowthCard />, { route: '/dividends?portfolio=trading-212' });
    const chart = await screen.findByTestId('year-compare-chart');
    const year = computeDividendGrowth(getAnalyticsData('trading-212')).byYear.at(-1)!;
    expect(sp(chart.getAttribute('aria-label')!)).toContain(sp(`${year.year}: ${formatMoney(year.total, 'EUR')}`));
  });

  it('shows an empty note and an error with retry', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/analytics/dividend-growth', () => HttpResponse.json({ ...growth(), byYear: [], byMonth: [], perShare: [] })));
    const first = renderWithProviders(<DividendGrowthCard />);
    expect(await screen.findByText(/No dividends received yet\. Add dividend transactions to compare years\./)).toBeInTheDocument();
    first.unmount();

    server.resetHandlers();
    server.use(http.get('/api/analytics/dividend-growth', () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 }), { once: true }));
    renderWithProviders(<DividendGrowthCard />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load dividend growth');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('year-compare-chart')).toBeInTheDocument();
  });
});
