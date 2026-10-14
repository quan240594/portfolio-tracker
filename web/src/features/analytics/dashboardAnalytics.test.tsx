import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { computeAnalyticsSummary, type AnalyticsSummaryResponse } from '@portfolio/shared';
import { DashboardPage } from '../../pages/DashboardPage';
import { renderWithProviders } from '../../test/utils';
import { server } from '../../mocks/server';
import { getAnalyticsData } from '../../mocks/db';

const SUMMARY = '/api/analytics/summary';
const summary = (): AnalyticsSummaryResponse => computeAnalyticsSummary(getAnalyticsData());
const respondWith = (over: Partial<AnalyticsSummaryResponse>) =>
  server.use(http.get(SUMMARY, () => HttpResponse.json({ ...summary(), ...over })));
const failSummary = () =>
  server.use(http.get(SUMMARY, () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 })));

const insight = (id: string, severity: 'info' | 'warning', symbols: string[] = []) => ({ id, severity, title: `Title ${id}`, detail: `Detail ${id}`, symbols });

describe('dashboard analytics', () => {
  it('shows IRR, TWR and passive income KPIs from the shared calculations', async () => {
    renderWithProviders(<DashboardPage />);
    const irr = screen.getByRole('region', { name: 'Money-weighted return (IRR)' });
    expect(irr).toHaveAttribute('aria-busy', 'true');
    const income = await screen.findByRole('region', { name: 'Passive income (next 12 months)' });
    expect(await within(income).findByText(/yield on value/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Time-weighted return (TWR)' })).getByText(/since/i)).toBeInTheDocument();
    expect(within(irr).queryByText('Not enough history yet')).not.toBeInTheDocument();
  });

  it('explains missing history, and non-annualised returns', async () => {
    const base = summary();
    respondWith({ performance: { ...base.performance, since: null, irrPct: null, twrPct: null, twrAnnualisedPct: null } });
    const first = renderWithProviders(<DashboardPage />);
    expect((await screen.findAllByText('Not enough history yet')).length).toBe(2);
    first.unmount();

    respondWith({ performance: { ...base.performance, since: '2026-05-01', irrAnnualised: false, irrPct: 3, twrPct: 4, twrAnnualisedPct: null } });
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText(/under a year, so not annualised/)).toBeInTheDocument();
    expect(screen.getByText(/excludes deposits and withdrawals/)).toBeInTheDocument();
  });

  it('shows the annualised TWR hint when there is more than a year of history', async () => {
    const base = summary();
    respondWith({ performance: { ...base.performance, since: '2024-01-01', irrAnnualised: true, irrPct: 7, twrPct: 20, twrAnnualisedPct: 8 } });
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText(/per year, since/, { selector: 'p, div, span' })).toBeInTheDocument();
  });

  it('lists the top day gainers and losers', async () => {
    renderWithProviders(<DashboardPage />);
    const gainers = await screen.findByRole('region', { name: 'Top day gainers' });
    const losers = screen.getByRole('region', { name: 'Top day losers' });
    expect(within(gainers).getAllByRole('listitem').length).toBe(summary().gainers.length);
    expect(within(losers).getAllByRole('listitem').length).toBe(summary().losers.length);
  });

  it('shows empty messages when nothing moved', async () => {
    respondWith({ gainers: [], losers: [] });
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('No holding is up today.')).toBeInTheDocument();
    expect(screen.getByText('No holding is down today.')).toBeInTheDocument();
  });

  it('shows an error per widget', async () => {
    failSummary();
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText('Could not load return analytics')).toBeInTheDocument();
    expect(screen.getByText('Could not load top movers')).toBeInTheDocument();
    expect(screen.queryByText('Portfolio insights')).not.toBeInTheDocument();
  });

  it('shows insights with severity and symbols, and dismisses and restores them', async () => {
    respondWith({ insights: [insight('a', 'warning', ['ABC', 'DEF']), insight('b', 'info')] });
    const user = userEvent.setup();
    renderWithProviders(<DashboardPage />);
    const section = await screen.findByRole('region', { name: 'Portfolio insights' });
    expect(within(section).getByText('Warning:')).toBeInTheDocument();
    expect(within(section).getByText('Info:')).toBeInTheDocument();
    expect(within(section).getByRole('list', { name: 'Affected holdings' })).toHaveTextContent('ABCDEF');

    await user.click(within(section).getByRole('button', { name: 'Dismiss insight: Title a' }));
    expect(within(section).queryByText('Detail a')).not.toBeInTheDocument();
    expect(within(section).getByText('Detail b')).toBeInTheDocument();
    expect(sessionStorage.getItem('pt-dismissed-insights')).toContain('all:a');

    await user.click(within(section).getByRole('button', { name: 'Dismiss insight: Title b' }));
    expect(within(section).queryByText('Detail b')).not.toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Show 2 dismissed' }));
    expect(within(section).getByText('Detail a')).toBeInTheDocument();
    expect(within(section).getByText('Detail b')).toBeInTheDocument();
  });

  it('renders nothing for the insights section without insights', async () => {
    respondWith({ insights: [] });
    renderWithProviders(<DashboardPage />);
    await screen.findByRole('region', { name: 'Top day gainers' });
    expect(screen.queryByRole('region', { name: 'Portfolio insights' })).not.toBeInTheDocument();
  });
});
