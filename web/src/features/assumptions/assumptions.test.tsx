import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { DividendOverviewHolding, DividendsOverviewResponse } from '@portfolio/shared';
import { API_BASE_URL } from '../../config';
import { server } from '../../mocks/server';
import { renderApp, renderWithProviders } from '../../test/utils';
import { GoalTab } from '../analytics/GoalTab';

const VERDICT = /Achievable in \d+ years? \(by \d{4}\)|Not reached within the horizon|Goal already reached/;
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const group = (name: string) => within(screen.getByRole('group', { name }));

const holding = (n: number, over: Partial<DividendOverviewHolding> = {}): DividendOverviewHolding => ({
  symbol: `PAY${n}`,
  name: `Payer ${n}`,
  assetClass: 'STOCK',
  currency: 'EUR',
  marketValue: 1000,
  costBasis: 800,
  forward12m: 40,
  declared: 40,
  estimated: 0,
  sharePct: 10,
  yieldPct: 4,
  yieldOnCostPct: 5,
  received12m: 40,
  receivedTotal: 120,
  growthPct: 6,
  growthYears: 3,
  consistency: { badge: 'RELIABLE', score: 80, payments: 12, yearsWithPayments: 3, paymentsPerYear: 4, regularityCv: 0.1, cuts: 0, growthStreak: 2, points: { history: 20, regularity: 20, cuts: 20, growth: 20 } },
  ...over,
});

/** Six payers worth 6000 in all plus a 94 000 fund that pays nothing: the portfolio yields 0,26% while the payers yield 4%. */
const overview = (over: Partial<DividendsOverviewResponse['summary']> = {}, holdings = [1, 2, 3, 4, 5, 6].map((n) => holding(n))): DividendsOverviewResponse => ({
  baseCurrency: 'EUR',
  asOf: '2026-10-27',
  summary: { forward12m: 240, declared: 240, estimated: 0, monthlyAverage: 20, yieldOnValuePct: 0.26, yieldOnCostPct: 5, last12m: 240, growthVsLast12mPct: null, ...over },
  holdings,
  futureMonths: [],
});

const serveOverview = (body: DividendsOverviewResponse) => server.use(http.get(`${API_BASE_URL}/dividends/overview`, () => HttpResponse.json(body)));

async function openAdvanced(route = '/goals?portfolio=default') {
  const user = userEvent.setup();
  renderApp(route);
  await screen.findByText(VERDICT, { selector: 'output' });
  await user.click(screen.getByRole('button', { name: 'Returns and inflation' }));
  return user;
}

describe('Goals form: dividend growth helper', () => {
  it('starts as Manual, calculates the per-share growth from the portfolio and goes back to Manual when typing', async () => {
    serveOverview(overview());
    const user = await openAdvanced();
    const growth = input('Dividend growth per year (%)');
    expect(group('Dividend growth source').getByRole('radio', { name: 'Manual' })).toBeChecked();
    expect(growth).toHaveValue('5');

    await user.click(await screen.findByRole('radio', { name: /From my portfolio/ }));
    await waitFor(() => expect(growth).toHaveValue('6'));
    expect(screen.getByText(/6 of 6 dividend-paying holdings \(100% of your forward income\), dividend per share over 3 full years/)).toBeInTheDocument();

    await user.clear(growth);
    await user.type(growth, '7');
    expect(group('Dividend growth source').getByRole('radio', { name: 'Manual' })).toBeChecked();
    expect(growth).toHaveValue('7');
  });

  it('says why nothing can be calculated and that a clamped figure was limited', async () => {
    serveOverview(overview({}, [holding(1, { growthPct: null, growthYears: 0 })]));
    server.use(http.get(`${API_BASE_URL}/analytics/dividend-growth`, () => HttpResponse.json({ growthStats: { cagr: null } })));
    await openAdvanced();
    expect(await screen.findByText(/Not enough history: 0 of 1 dividend payer has a full year/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /From my portfolio/ })).toBeDisabled();
  });

  it('falls back to the growth of the total dividends received when no holding has per-share history', async () => {
    serveOverview(overview({}, [holding(1, { growthPct: null, growthYears: 0 })]));
    server.use(
      http.get(`${API_BASE_URL}/analytics/dividend-growth`, () =>
        HttpResponse.json({ growthStats: { cagr: { startYear: 2023, endYear: 2025, startAmount: 120, endAmount: 310, years: 2, pct: 26.7 } } }),
      ),
    );
    const user = await openAdvanced();
    await user.click(await screen.findByRole('radio', { name: /From my portfolio/ }));
    await waitFor(() => expect(input('Dividend growth per year (%)')).toHaveValue('26,7'));
    expect(screen.getByText(/total dividends received, 2023 to 2025 \(2 full years\); this includes the effect of buying or selling shares/)).toBeInTheDocument();
  });

  it('limits one holding’s growth to the range of the field so a special dividend cannot dominate', async () => {
    serveOverview(overview({}, [holding(1, { growthPct: 45 })]));
    const user = await openAdvanced();
    await user.click(await screen.findByRole('radio', { name: /From my portfolio/ }));
    await waitFor(() => expect(input('Dividend growth per year (%)')).toHaveValue('30'));
  });

  it('shows the error when the overview cannot be read', async () => {
    server.use(http.get(`${API_BASE_URL}/dividends/overview`, () => HttpResponse.json({ error: { code: 'X', message: 'Boom' } }, { status: 500 })));
    await openAdvanced();
    expect(await screen.findByText(/Could not calculate dividend growth: Boom/)).toBeInTheDocument();
    expect(await screen.findByText(/Could not calculate the yield: Boom/)).toBeInTheDocument();
  });
});

describe('Goals form: yield on new money helper', () => {
  it('shows every preset side by side and defaults to dividend payers only for a low portfolio yield with five payers', async () => {
    serveOverview(overview());
    await openAdvanced();
    const payers = await screen.findByRole('radio', { name: /Dividend payers only/ });
    await waitFor(() => expect(payers).toBeChecked());
    expect(input('Yield on new money (%)')).toHaveValue('4');
    expect(screen.getByRole('radio', { name: /Portfolio forward yield/ })).toHaveAccessibleName(/0,26%/);
    expect(payers).toHaveAccessibleName(/4,00%/);
    expect(screen.getByRole('radio', { name: /Yield on cost/ })).toHaveAccessibleName(/5,00%/);
    expect(screen.getByText(/forward 12-month income of € 240 divided by the market value of only the 6 holdings that pay dividends/)).toBeInTheDocument();
  });

  it('keeps the manual yield when the portfolio yield is not low, and lets a preset be chosen', async () => {
    serveOverview(overview({ yieldOnValuePct: 4 }));
    const user = await openAdvanced();
    expect(await screen.findByRole('radio', { name: /Yield on cost/ })).not.toBeChecked();
    expect(group('Yield on new money from').getByRole('radio', { name: 'Manual' })).toBeChecked();
    expect(input('Yield on new money (%)')).toHaveValue('3,5');
    await user.click(screen.getByRole('radio', { name: /Yield on cost/ }));
    await waitFor(() => expect(input('Yield on new money (%)')).toHaveValue('5'));
    await user.click(screen.getByRole('radio', { name: /Portfolio forward yield/ }));
    await waitFor(() => expect(input('Yield on new money (%)')).toHaveValue('4'));
  });

  it('limits a yield above the range of the field and says so', async () => {
    serveOverview(overview({ yieldOnValuePct: 40, yieldOnCostPct: 45 }, [holding(1, { marketValue: 100, forward12m: 40 })]));
    const user = await openAdvanced();
    await user.click(await screen.findByRole('radio', { name: /Portfolio forward yield/ }));
    await waitFor(() => expect(input('Yield on new money (%)')).toHaveValue('30'));
    expect(screen.getByText(/Calculated 40,00%, limited to 30,00% \(the range this field accepts\)/)).toBeInTheDocument();
  });

  it('does not touch a saved goal', async () => {
    serveOverview(overview());
    const user = await openAdvanced();
    await screen.findByRole('radio', { name: /Dividend payers only/, checked: true });
    await user.click(screen.getByRole('button', { name: 'Save and calculate' }));
    await screen.findByText('Saved');
    expect(input('Yield on new money (%)')).toHaveValue('4');
  });

  it('says so when there is no dividend income to base a yield on', async () => {
    serveOverview(overview({ forward12m: 0, yieldOnValuePct: 0, yieldOnCostPct: 0 }, []));
    await openAdvanced();
    expect(await screen.findByText(/No dividend income yet, so there is no yield to calculate/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Portfolio forward yield/ })).toBeDisabled();
  });
});

describe('Goals form: inflation helper', () => {
  it('averages the ECB series over the chosen period and area, from the server', async () => {
    const user = await openAdvanced();
    expect(screen.queryByLabelText('Inflation period')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /ECB history/ }));
    expect(await screen.findByLabelText('Inflation period')).toHaveValue('10y');
    await waitFor(() => expect(input('Inflation per year (%)').value).toMatch(/^\d,\d$/));
    expect(screen.getByText(/average over the last 10 years \(september 2016 to september 2026\), compounded/i)).toBeInTheDocument();
    expect(screen.getByText(/ECB data, latest september 2026, cached from 01-10-2026/i)).toBeInTheDocument();

    const tenYears = input('Inflation per year (%)').value;
    await user.selectOptions(screen.getByLabelText('Inflation period'), '5y');
    await waitFor(() => expect(input('Inflation per year (%)').value).not.toBe(tenYears));
    expect(screen.getByText(/average over the last 5 years/)).toBeInTheDocument();

    const euro = input('Inflation per year (%)').value;
    await user.selectOptions(screen.getByLabelText('Inflation area'), 'NL');
    await waitFor(() => expect(input('Inflation per year (%)').value).not.toBe(euro));
  });

  it('offers the long run since 1999 and the 2% target', async () => {
    const user = await openAdvanced();
    await user.click(screen.getByRole('radio', { name: /ECB history/ }));
    await user.selectOptions(await screen.findByLabelText('Inflation period'), 'all');
    await waitFor(() => expect(screen.getByText(/average over the last 28 years/)).toBeInTheDocument());
    await user.click(screen.getByRole('radio', { name: /ECB target/ }));
    await waitFor(() => expect(input('Inflation per year (%)')).toHaveValue('2'));
    expect(screen.getByText(/medium-term target \(2,0%\)/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Inflation period')).not.toBeInTheDocument();
    await user.type(input('Inflation per year (%)'), '5');
    expect(group('Inflation source').getByRole('radio', { name: 'Manual' })).toBeChecked();
  });

  it('says so when the ECB cannot be reached, and keeps the typed value', async () => {
    server.use(http.get(`${API_BASE_URL}/inflation`, () => HttpResponse.json({ error: { code: 'INFLATION_UNAVAILABLE', message: 'No ECB' } }, { status: 502 })));
    const user = await openAdvanced();
    await user.click(screen.getByRole('radio', { name: /ECB history/ }));
    expect(await screen.findByText(/Could not calculate inflation: No ECB. Enter a value yourself./)).toBeInTheDocument();
    expect(input('Inflation per year (%)')).toHaveValue('2');
  });

  it('says so when a stale series is shown or the series is too short for the period', async () => {
    server.use(
      http.get(`${API_BASE_URL}/inflation`, () =>
        HttpResponse.json({
          area: 'U2',
          series: 'ICP.M.U2.N.000000.4.ANR',
          points: [{ month: '2026-09', ratePct: 2.5 }, { month: '2025-09', ratePct: 2 }],
          latestMonth: '2026-09',
          fetchedAt: '2026-09-30T06:00:00.000Z',
          stale: true,
        }),
      ),
    );
    const user = await openAdvanced();
    await user.click(screen.getByRole('radio', { name: /ECB history/ }));
    expect(await screen.findByText(/The ECB series covers only 2 full years: choose a shorter period/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Inflation period'), 'all');
    expect(await screen.findByText(/the ECB could not be reached, cached from 30-09-2026/)).toBeInTheDocument();
  });
});

describe('info popovers', () => {
  it('open from the "i", explain the helper and close with Escape, returning the focus', async () => {
    const user = await openAdvanced();
    for (const name of ['About Dividend growth source', 'About Yield on new money from', 'About Inflation source']) {
      const summary = screen.getByText((_, el) => el?.tagName === 'SUMMARY' && el.getAttribute('aria-label') === name);
      const details = summary.closest('details')!;
      expect(details).not.toHaveAttribute('open');
      await user.click(summary);
      expect(details).toHaveAttribute('open');
      expect(details).toHaveTextContent(/Typing in the field switches back to Manual|Below 1% with at least 5 payers/);
      await user.keyboard('{Escape}');
      expect(details).not.toHaveAttribute('open');
      expect(summary).toHaveFocus();
    }
  });
});

describe('Analytics income goal tab: helpers', () => {
  it('offers the growth and yield helpers (no inflation input there)', async () => {
    serveOverview(overview());
    const user = userEvent.setup();
    renderWithProviders(<GoalTab />);
    await screen.findByRole('table', { name: 'Projection per scenario' });
    expect(screen.queryByText('Inflation source')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('radio', { name: /From my portfolio/ }));
    await waitFor(() => expect(input('Dividend growth per year (%)')).toHaveValue('6'));
    await user.click(screen.getByRole('radio', { name: /Dividend payers only/ }));
    await waitFor(() => expect(input('Yield on new money (%)')).toHaveValue('4'));
    await user.type(input('Yield on new money (%)'), '5');
    expect(group('Yield on new money from').getByRole('radio', { name: 'Manual' })).toBeChecked();
  });
});
