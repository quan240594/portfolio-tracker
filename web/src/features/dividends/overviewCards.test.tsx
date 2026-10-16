import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { computeDividendsOverview, type DividendOverviewHolding, type DividendsOverviewResponse } from '@portfolio/shared';
import { renderWithProviders, sp } from '../../test/utils';
import { server } from '../../mocks/server';
import { getAnalyticsData } from '../../mocks/db';
import { formatMoney, formatPercent, formatWeight } from '../../lib/format';
import { DiversificationCard } from './DiversificationCard';
import { ConsistencyCard, scoreBreakdown } from './ConsistencyCard';
import { AverageGrowthCard, FutureKey, FutureLegend, FuturePaymentsCard, futureTooltipRow, growthBars } from './GrowthAndFuture';
import { useDividendTheme } from './chartParts';
import { DividendsKpi, YieldKpi } from './YieldKpis';
import { YieldPayoutCard } from './YieldPayoutCard';

const OVERVIEW = '/api/dividends/overview';
const overview = (scope?: string): DividendsOverviewResponse => computeDividendsOverview(getAnalyticsData(scope));
const respondWith = (data: DividendsOverviewResponse) => server.use(http.get(OVERVIEW, () => HttpResponse.json(data)));
const failOnce = () => server.use(http.get(OVERVIEW, () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 }), { once: true }));

const holding = (symbol: string, over: Partial<DividendOverviewHolding> = {}): DividendOverviewHolding => ({
  ...overview().holdings[0]!,
  symbol,
  name: `${symbol} Corp`,
  ...over,
});

describe('Yield and Dividends KPIs', () => {
  it('shows the forward yield with the yield on cost', async () => {
    const { summary, holdings } = overview();
    renderWithProviders(<YieldKpi />);
    const card = screen.getByRole('region', { name: 'Yield' });
    expect(card).toHaveAttribute('aria-busy', 'true');
    expect(await within(card).findByTestId('kpi-yield')).toHaveTextContent(sp(formatPercent(summary.yieldOnValuePct)));
    expect(card).toHaveTextContent(sp(`Yield on cost ${formatPercent(summary.yieldOnCostPct)}`));
    expect(card).toHaveTextContent(`from ${holdings.filter((h) => h.forward12m > 0).length} dividend-paying holdings`);
    expect(card).not.toHaveAttribute('aria-busy');
  });

  it('shows the forward income, the monthly average and the growth', async () => {
    const data = overview();
    renderWithProviders(<DividendsKpi />);
    const card = await screen.findByRole('region', { name: 'Dividends' });
    expect(await within(card).findByTestId('kpi-income')).toHaveTextContent(sp(formatMoney(data.summary.forward12m, 'EUR')));
    expect(card).toHaveTextContent(sp(`${formatMoney(data.summary.monthlyAverage, 'EUR')} per month on average`));
    expect(card).toHaveTextContent(sp(`${formatPercent(data.summary.growthVsLast12mPct!, { signed: true, digits: 1 })} vs the previous 12 months (${formatMoney(data.summary.last12m, 'EUR')} received)`));
  });

  it('colours a decline and explains a missing comparison', async () => {
    const data = overview();
    respondWith({ ...data, summary: { ...data.summary, growthVsLast12mPct: -12.5 } });
    const first = renderWithProviders(<DividendsKpi />);
    expect(await screen.findByText(sp('−12,5%'))).toHaveClass('loss-text');
    first.unmount();

    respondWith({ ...data, summary: { ...data.summary, growthVsLast12mPct: null } });
    renderWithProviders(<DividendsKpi />);
    expect(await screen.findByText('No dividends received in the previous 12 months to compare with')).toBeInTheDocument();
  });

  it('counts one paying holding in the singular and explains the metric in a tip', async () => {
    const user = userEvent.setup();
    const data = overview();
    respondWith({ ...data, holdings: [data.holdings[0]!] });
    renderWithProviders(<YieldKpi />);
    expect(await screen.findByText(/from 1 dividend-paying holding$/)).toBeInTheDocument();
    const tip = screen.getByText(/Forward yield: the dividends you are expected/);
    expect(tip).not.toBeVisible();
    await user.click(screen.getByText('i'));
    expect(tip).toBeVisible();
  });

  it('shows an error and retries', async () => {
    const user = userEvent.setup();
    failOnce();
    renderWithProviders(<YieldKpi />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load yield');
    expect(alert).toHaveTextContent('Boom');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('kpi-yield')).toBeInTheDocument();
  });
});

describe('YieldPayoutCard', () => {
  it('draws one bar per paying holding, highest yield first, with a data table', async () => {
    const user = userEvent.setup();
    const { holdings } = overview();
    renderWithProviders(<YieldPayoutCard />);
    expect(screen.getByText('Loading yield and payout')).toBeInTheDocument();
    const chart = await screen.findByTestId('yield-payout-chart');
    const payers = holdings.filter((h) => h.forward12m > 0).sort((a, b) => b.yieldPct - a.yieldPct);
    expect(chart).toHaveAccessibleName(new RegExp(`^Dividend yield per ${payers.length} bars, highest first: ${payers[0]!.symbol} `));
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(legend).toHaveTextContent('Yield on value');
    expect(legend).toHaveTextContent('Yield on cost');

    await user.click(screen.getByText('Show data table'));
    const rows = within(screen.getByRole('table', { name: 'Dividend yield and forward annual amount' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(payers.length);
    expect(rows[0]).toHaveTextContent(payers[0]!.name);
    expect(rows[0]).toHaveTextContent(sp(formatPercent(payers[0]!.yieldPct)));
    expect(rows[0]).toHaveTextContent(sp(formatPercent(payers[0]!.yieldOnCostPct)));
  });

  it('switches to the yearly amount per holding', async () => {
    const user = userEvent.setup();
    renderWithProviders(<YieldPayoutCard />);
    await screen.findByTestId('yield-payout-chart');
    await user.click(screen.getByRole('radio', { name: 'Amount (EUR)' }));
    expect(screen.getByRole('radio', { name: 'Amount (EUR)' })).toBeChecked();
    expect(screen.getByTestId('yield-payout-chart')).toHaveAccessibleName(/^Forward annual dividend amount per \d+ bars/);
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(legend).toHaveTextContent('Amount per year');
    expect(legend).not.toHaveTextContent('Yield on cost');
  });

  it('only offers grouping by category for a portfolio that has categories', async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<YieldPayoutCard />);
    await screen.findByTestId('yield-payout-chart');
    expect(screen.queryByRole('radiogroup', { name: 'Group by' })).not.toBeInTheDocument();
    first.unmount();

    renderWithProviders(<YieldPayoutCard />, { route: '/dividends?portfolio=default' });
    await user.click(await screen.findByRole('radio', { name: 'Categories' }));
    const chart = screen.getByTestId('yield-payout-chart');
    expect(chart).toHaveAccessibleName(/per 2 bars/);
    expect(chart).toHaveAccessibleName(/Core ETFs/);
    expect(chart).toHaveAccessibleName(/Single stocks/);
    await user.click(screen.getByRole('radio', { name: 'Holdings' }));
    expect(screen.getByTestId('yield-payout-chart')).toHaveAccessibleName(/VWRL\.AS/);
  });

  it('says so when no holding pays dividends', async () => {
    respondWith({ ...overview(), holdings: [] });
    renderWithProviders(<YieldPayoutCard />);
    expect(await screen.findByText('No dividend-paying holdings yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('yield-payout-chart')).not.toBeInTheDocument();
  });

  it('shows an error and retries', async () => {
    const user = userEvent.setup();
    failOnce();
    renderWithProviders(<YieldPayoutCard />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load yield and payout');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('yield-payout-chart')).toBeInTheDocument();
  });
});

describe('DiversificationCard', () => {
  it('shows the income share per holding in a donut and a ranked list', async () => {
    const { holdings } = overview();
    renderWithProviders(<DiversificationCard />);
    expect(screen.getByText('Loading income diversification')).toBeInTheDocument();
    const donut = await screen.findByTestId('income-donut');
    const payers = holdings.filter((h) => h.forward12m > 0).sort((a, b) => b.forward12m - a.forward12m);
    const total = payers.reduce((s, h) => s + h.forward12m, 0);
    expect(sp(donut.getAttribute('aria-label')!)).toContain(`by holding: ${payers[0]!.name} ${formatWeight(payers[0]!.forward12m / total)}`);
    const items = within(screen.getByRole('list', { name: 'Holdings ranked by expected annual income' })).getAllByRole('listitem');
    expect(items).toHaveLength(payers.length);
    expect(items[0]).toHaveTextContent(payers[0]!.name);
    expect(items[0]).toHaveTextContent(payers[0]!.symbol);
    expect(items[0]).toHaveTextContent(sp(formatWeight(payers[0]!.forward12m / total)));
    expect(items[0]).toHaveTextContent(sp(formatMoney(payers[0]!.forward12m, 'EUR')));
  });

  it('collapses everything beyond the eight largest into Other', async () => {
    const data = overview();
    const many = Array.from({ length: 10 }, (_, i) => holding(`S${i}`, { forward12m: 100 - i * 5 }));
    respondWith({ ...data, holdings: many });
    renderWithProviders(<DiversificationCard />);
    const items = within(await screen.findByRole('list', { name: 'Holdings ranked by expected annual income' })).getAllByRole('listitem');
    expect(items).toHaveLength(9);
    expect(items.at(-1)).toHaveTextContent('Other');
    expect(items.at(-1)).toHaveTextContent('2 more');
    expect(items.at(-1)).toHaveTextContent(sp(formatMoney(60 + 55, 'EUR')));
  });

  it('shows the table alternative, an empty note and an error with retry', async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<DiversificationCard />);
    await screen.findByTestId('income-donut');
    await user.click(screen.getByText('Show data table'));
    expect(screen.getByRole('table', { name: 'Forward annual dividend income by holding' })).toBeInTheDocument();
    first.unmount();

    respondWith({ ...overview(), holdings: [holding('X', { forward12m: 0 })] });
    const second = renderWithProviders(<DiversificationCard />);
    expect(await screen.findByText('No expected dividend income to divide yet.')).toBeInTheDocument();
    second.unmount();

    server.resetHandlers();
    failOnce();
    renderWithProviders(<DiversificationCard />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load income diversification');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('income-donut')).toBeInTheDocument();
  });
});

describe('ConsistencyCard', () => {
  it('counts the badges and lists every holding with its score', async () => {
    const { holdings } = overview();
    renderWithProviders(<ConsistencyCard />);
    expect(screen.getByText('Loading dividend safety')).toBeInTheDocument();
    const donut = await screen.findByTestId('consistency-donut');
    expect(donut).toHaveAccessibleName(/^Holdings by dividend safety: 3 Reliable, 1 OK, 1 Irregular, 1 New\.$/);
    expect(screen.getByText('Based on your payment history, not a forecast or advice.')).toBeInTheDocument();

    const counts = within(screen.getByRole('list', { name: 'Holdings per badge' })).getAllByRole('listitem');
    expect(counts.map((li) => li.textContent)).toEqual(['Reliable3', 'OK1', 'Irregular1', 'New1']);

    const table = screen.getByRole('table', { name: 'Dividend safety per holding' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(holdings.length);
    const top = holdings[0]!;
    expect(rows[0]).toHaveTextContent(top.name);
    expect(rows[0]).toHaveTextContent(sp(formatMoney(top.forward12m, 'EUR')));
    expect(rows[0]).toHaveTextContent(sp(formatPercent(top.yieldPct)));
    expect(within(rows[0]!).getByText(top.consistency.badge === 'OK' ? 'OK' : /Reliable|Irregular|New/)).toHaveAttribute('title', scoreBreakdown(top.consistency));
    expect(within(table).getByText('New')).toHaveAttribute('title', 'Fewer than 2 known payments');
  });

  it('explains how the score is derived', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConsistencyCard />);
    await screen.findByTestId('consistency-donut');
    const help = screen.getByText(/The score \(0-100\) is computed only from your own data/);
    expect(help).not.toBeVisible();
    await user.click(screen.getByText('How is the score calculated?'));
    expect(help).toBeVisible();
    expect(screen.getByText(/Full points when the gaps vary by at most 5%/)).toBeVisible();
    expect(screen.getByText(/^Badges:/)).toHaveTextContent('Reliable 70+, OK 40-69, Irregular below 40, New with fewer than 2 known payments');
    expect(screen.getByText(/Based on your payment history, not a forecast or advice. It says nothing/)).toBeVisible();
  });

  it('uses the singular in the tooltip of a one-holding donut and offers a table alternative', async () => {
    const user = userEvent.setup();
    const data = overview();
    respondWith({ ...data, holdings: [data.holdings[0]!] });
    renderWithProviders(<ConsistencyCard />);
    await screen.findByTestId('consistency-donut');
    await user.click(screen.getByText('Show data table'));
    expect(screen.getByRole('table', { name: 'Dividend safety badge counts' })).toBeInTheDocument();
  });

  it('shows an empty note and an error with retry', async () => {
    const user = userEvent.setup();
    respondWith({ ...overview(), holdings: [] });
    const first = renderWithProviders(<ConsistencyCard />);
    expect(await screen.findByText('No dividend-paying holdings yet.')).toBeInTheDocument();
    first.unmount();

    server.resetHandlers();
    failOnce();
    renderWithProviders(<ConsistencyCard />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load dividend safety');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('consistency-donut')).toBeInTheDocument();
  });
});

describe('AverageGrowthCard', () => {
  it('draws the per-share growth of every holding that has two full years, fastest first', async () => {
    const data = overview();
    const bars = growthBars(data);
    expect(bars.length).toBeGreaterThan(2);
    renderWithProviders(<AverageGrowthCard />);
    expect(screen.getByText('Loading dividend growth')).toBeInTheDocument();
    const chart = await screen.findByTestId('growth-cagr-chart');
    expect(chart).toHaveAccessibleName(new RegExp(`^Average annual dividend growth per share, ${bars.length} holdings: ${bars[0]!.symbol} `));
    expect(bars.map((b) => b.growthPct)).toEqual([...bars.map((b) => b.growthPct)].sort((a, b) => b - a));
    expect(bars.at(-1)!.growthPct).toBeLessThan(0);
    expect(screen.getByText(`${data.holdings.length - bars.length} holding without two full years of payments not shown.`)).toBeInTheDocument();
  });

  it('lists the growth rates in a table', async () => {
    const user = userEvent.setup();
    const bars = growthBars(overview());
    renderWithProviders(<AverageGrowthCard />);
    await screen.findByTestId('growth-cagr-chart');
    await user.click(screen.getByText('Show data table'));
    const rows = within(screen.getByRole('table', { name: 'Average annual dividend growth per share' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(bars.length);
    expect(rows[0]).toHaveTextContent(sp(formatPercent(bars[0]!.growthPct, { signed: true })));
  });

  it('explains when there is not enough history and retries after an error', async () => {
    const user = userEvent.setup();
    const data = overview();
    respondWith({ ...data, holdings: data.holdings.map((h) => ({ ...h, growthPct: null })) });
    const first = renderWithProviders(<AverageGrowthCard />);
    expect(await screen.findByText(/Not enough payment history yet/)).toBeInTheDocument();
    first.unmount();

    server.resetHandlers();
    failOnce();
    renderWithProviders(<AverageGrowthCard />);
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('growth-cagr-chart')).toBeInTheDocument();
  });

  it('does not mention holdings that are all measurable', async () => {
    const data = overview();
    const measurable = data.holdings.filter((h) => h.growthPct !== null);
    respondWith({ ...data, holdings: measurable });
    renderWithProviders(<AverageGrowthCard />);
    await screen.findByTestId('growth-cagr-chart');
    expect(screen.queryByText(/without two full years/)).not.toBeInTheDocument();
  });

  it('pluralises the note for several holdings without history', async () => {
    const data = overview();
    const withoutHistory = data.holdings.slice(0, 2).map((h) => ({ ...h, growthPct: null }));
    respondWith({ ...data, holdings: [...data.holdings.filter((h) => h.growthPct !== null).slice(0, 1), ...withoutHistory] });
    renderWithProviders(<AverageGrowthCard />);
    expect(await screen.findByText('2 holdings without two full years of payments not shown.')).toBeInTheDocument();
  });
});

describe('FuturePaymentsCard', () => {
  it('shows the next 12 months and the monthly average above the stacked chart', async () => {
    const user = userEvent.setup();
    const { summary, futureMonths } = overview();
    renderWithProviders(<FuturePaymentsCard />);
    expect(screen.getByText('Loading future payments')).toBeInTheDocument();
    expect(await screen.findByTestId('future-total')).toHaveTextContent(sp(formatMoney(summary.forward12m, 'EUR')));
    expect(screen.getByTestId('future-average')).toHaveTextContent(sp(formatMoney(summary.monthlyAverage, 'EUR')));
    expect(sp(screen.getByTestId('future-chart').getAttribute('aria-label')!)).toBe(
      sp(`Expected dividends per month over the next 12 months, ${formatMoney(summary.forward12m, 'EUR')} in total: ${formatMoney(summary.declared, 'EUR')} declared and ${formatMoney(summary.estimated, 'EUR')} estimated.`),
    );
    await user.click(screen.getByText('Show data table'));
    const rows = within(screen.getByRole('table', { name: 'Expected dividends per month' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(12);
    const first = futureMonths[0]!;
    expect(rows[0]).toHaveTextContent(sp(formatMoney(first.declared, 'EUR')));
    expect(rows[0]).toHaveTextContent(sp(formatMoney(first.estimated, 'EUR')));
  });

  it('shows an error and retries', async () => {
    const user = userEvent.setup();
    failOnce();
    renderWithProviders(<FuturePaymentsCard />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load future payments');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('future-chart')).toBeInTheDocument();
  });

  it('follows the portfolio scope', async () => {
    const trading = overview('trading-212');
    renderWithProviders(<FuturePaymentsCard />, { route: '/dividends?portfolio=trading-212' });
    expect(await screen.findByTestId('future-total')).toHaveTextContent(sp(formatMoney(trading.summary.forward12m, 'EUR')));
    expect(trading.summary.forward12m).not.toBe(overview().summary.forward12m);
  });
});

describe('future payments colour key', () => {
  function KeyHarness() {
    const c = useDividendTheme();
    const [amount, key] = futureTooltipRow('EUR', c)(12.5, 'estimated');
    return (
      <>
        <FutureLegend payload={[{ value: 'declared' }, { value: 'estimated' }]} c={c} />
        <FutureLegend c={c} />
        <FutureKey name="declared" c={c} />
        <FutureKey name="paid" c={c} />
        <FutureKey name="avg" c={c} />
        <FutureLegend payload={[{ value: 'total', type: 'none' }]} c={c} />
        <p data-testid="row">{amount}</p>
        {key}
      </>
    );
  }

  it('names every status next to its swatch, solid for declared and dashed for estimated', () => {
    const { container } = renderWithProviders(<KeyHarness />);
    expect(screen.getAllByText('Declared').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Estimated').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('row')).toHaveTextContent(sp(formatMoney(12.5, 'EUR')));
    const swatches = [...container.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')];
    expect(swatches.some((s) => s.style.border.includes('dashed'))).toBe(true);
    expect(swatches.some((s) => s.style.border.includes('solid'))).toBe(true);
    // Received in the calendar's green, the average line as a dashed rule, and helper series (type none) without an entry
    expect(screen.getByText('Received')).toBeInTheDocument();
    expect(screen.getByText('avg')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
