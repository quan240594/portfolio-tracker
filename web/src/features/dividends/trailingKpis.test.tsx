import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { computeDividendsOverview, type DividendOverviewSummary } from '@portfolio/shared';
import { DashboardPage } from '../../pages/DashboardPage';
import { getAnalyticsData } from '../../mocks/db';
import { server } from '../../mocks/server';
import { formatPercent } from '../../lib/format';
import { renderWithProviders, sp } from '../../test/utils';

const OVERVIEW = '/api/dividends/overview';
const base = () => computeDividendsOverview(getAnalyticsData());

const respondWith = (over: Partial<DividendOverviewSummary>) => {
  const overview = base();
  server.use(http.get(OVERVIEW, () => HttpResponse.json({ ...overview, summary: { ...overview.summary, ...over } })));
};

const loaded = async (name: string) => {
  await waitFor(() => expect(screen.getByRole('region', { name })).not.toHaveAttribute('aria-busy'));
  return screen.getByRole('region', { name });
};
const yieldCard = () => loaded('Dividend yield (TTM)');
const growthCard = () => loaded('Dividend growth (TTM)');

describe('dashboard stat cards', () => {
  it('has twelve standard cards, one card each (3 per row on desktop, 1 on phones), then cash and custom assets when held', async () => {
    renderWithProviders(<DashboardPage />);
    await yieldCard();
    const cards = [...document.querySelectorAll<HTMLElement>('[data-card-id^="kpi-"]')];
    expect(cards.every((card) => card.dataset.width === 'third')).toBe(true);
    expect(cards.flatMap((card) => within(card).queryAllByRole('region')).map((card) => card.getAttribute('aria-label'))).toEqual([
      'Total value',
      'Day change',
      'Unrealized P&L',
      'Currency effect',
      'Total return',
      'Dividends received',
      'Realized P&L',
      'Money-weighted return (IRR)',
      'Time-weighted return (TWR)',
      'Dividend yield (TTM)',
      'Dividend growth (TTM)',
      'Passive income (next 12 months)',
      'Cash',
      'Custom assets',
    ]);
  });
});

describe('Dividend yield (TTM) card', () => {
  it('shows a loading placeholder, then the trailing yield on value and on cost with its basis', async () => {
    renderWithProviders(<DashboardPage />);
    expect(screen.getByRole('region', { name: 'Dividend yield (TTM)' })).toHaveAttribute('aria-busy', 'true');
    const { summary } = base();
    const card = await yieldCard();
    await within(card).findByText(/Trailing 12 months/);
    expect(within(card).getByTestId('kpi-value')).toHaveTextContent(formatPercent(summary.ttmYieldOnValuePct));
    expect(sp(card.textContent!)).toContain(`${formatPercent(summary.ttmYieldOnCostPct)} on cost`);
    expect(within(card).getByText(/% on cost/)).toBeInTheDocument();
    expect(within(card).getByText(/dividend-paying holding/)).toBeInTheDocument();
  });

  it('formats the figures in the Dutch notation', async () => {
    respondWith({ last12m: 376.95, ttmYieldOnValuePct: 1.25, ttmYieldOnCostPct: 1.36, ttmPayers: 16 });
    renderWithProviders(<DashboardPage />);
    const card = await yieldCard();
    await within(card).findByText('Trailing 12 months, 16 dividend-paying holdings');
    expect(sp(card.textContent!)).toContain('1,25%');
    expect(sp(card.textContent!)).toContain('1,36% on cost · € 376,95 received');
  });

  it('uses the singular for one holding and says so when nothing was received', async () => {
    respondWith({ ttmPayers: 1 });
    const first = renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('Trailing 12 months, 1 dividend-paying holding')).toBeInTheDocument();
    first.unmount();

    respondWith({ last12m: 0, ttmYieldOnValuePct: 0, ttmYieldOnCostPct: 0, ttmPayers: 0 });
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('No dividends received in the last 12 months')).toBeInTheDocument();
  });

  it('explains the definition and the difference with the forward income in the info tip', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DashboardPage />);
    const card = await yieldCard();
    await user.click(within(card).getByLabelText('About Dividend yield (TTM)'));
    expect(within(card).getByText(/TTM means trailing twelve months/)).toBeInTheDocument();
    expect(within(card).getByText(/looks back at what was received/)).toHaveTextContent('Passive income (next 12 months)');
    expect(within(card).getByText(/looks back at what was received/)).toHaveTextContent('looks ahead');
  });
});

describe('Dividend growth (TTM) card', () => {
  it('shows the growth with sign and arrow and the two amounts it compares', async () => {
    respondWith({ last12m: 376.95, previous12m: 347, ttmGrowthPct: 8.63, previous12mPartial: false });
    renderWithProviders(<DashboardPage />);
    const card = await growthCard();
    await within(card).findByText('+8,6%');
    expect(sp(card.textContent!)).toContain('€ 376,95 vs € 347,00');
    expect(within(card).getByText('Net received, last 12 months vs the 12 months before')).toBeInTheDocument();
    expect(within(card).getByText('up')).toBeInTheDocument();
  });

  it('shows a decline as a loss', async () => {
    respondWith({ last12m: 90, previous12m: 100, ttmGrowthPct: -10 });
    renderWithProviders(<DashboardPage />);
    const card = await growthCard();
    expect(await within(card).findByText('\u221210,0%')).toBeInTheDocument();
    expect(within(card).getByText('down')).toBeInTheDocument();
  });

  it('warns when the previous 12 months are only partly covered by the history', async () => {
    respondWith({ last12m: 20, previous12m: 10, ttmGrowthPct: 100, previous12mPartial: true });
    renderWithProviders(<DashboardPage />);
    const card = await growthCard();
    expect(await within(card).findByText(/first dividend came during that earlier period/)).toBeInTheDocument();
  });

  it('shows n/a with the reason, never a number, when there is nothing to compare with', async () => {
    respondWith({ last12m: 50, previous12m: 0, ttmGrowthPct: null });
    const first = renderWithProviders(<DashboardPage />);
    let card = await growthCard();
    expect(await within(card).findByText('No dividends received in the previous 12 months to compare with')).toBeInTheDocument();
    expect(within(card).getByTestId('kpi-value')).toHaveTextContent(/^n\/a$/);
    expect(card.textContent).not.toMatch(/%/);
    first.unmount();

    respondWith({ last12m: 0, previous12m: 0, ttmGrowthPct: null });
    renderWithProviders(<DashboardPage />);
    card = await growthCard();
    expect(await within(card).findByText('No dividends received in the last 24 months')).toBeInTheDocument();
    expect(within(card).getByTestId('kpi-value')).toHaveTextContent(/^n\/a$/);
  });

  it('explains what TTM growth compares in the info tip', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DashboardPage />);
    const card = await growthCard();
    await user.click(within(card).getByLabelText('About Dividend growth (TTM)'));
    expect(within(card).getByText(/TTM means trailing twelve months/)).toHaveTextContent('the 12 months before that');
    expect(within(card).getByText(/It shows n\/a when nothing was received/)).toBeInTheDocument();
  });
});

describe('trailing dividend cards when the overview fails', () => {
  it('shows one error with a retry and keeps the other cards', async () => {
    const user = userEvent.setup();
    server.use(http.get(OVERVIEW, () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 }), { once: true }));
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('Could not load trailing dividends')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Passive income (next 12 months)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await yieldCard()).toBeInTheDocument();
    expect(screen.queryByText('Could not load trailing dividends')).not.toBeInTheDocument();
  });
});
