import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { computeAnalyticsSummary, type AnalyticsSummaryResponse, type GrowthBenchmarkOption, type Holding, type WatchlistItem } from '@portfolio/shared';
import { MoversSection } from './features/analytics/MoversSection';
import { SecuritiesSection } from './features/assets/SecuritiesSection';
import { BenchmarksBar } from './features/growth/BenchmarksBar';
import { HoldingsTable } from './features/holdings/HoldingsTable';
import { WatchlistTable } from './features/watchlist/WatchlistTable';
import { DashboardPage } from './pages/DashboardPage';
import { getAnalyticsData } from './mocks/db';
import { server } from './mocks/server';
import { renderWithProviders } from './test/utils';

const VWRL = 'Vanguard FTSE All-World UCITS ETF (Dist)';
const IWDA = 'iShares Core MSCI World UCITS ETF (Acc)';
const EMIM = 'iShares Core MSCI Emerging Markets IMI UCITS ETF (Acc)';

const CLIPPING = /(^|\s)(truncate|text-ellipsis|text-clip|line-clamp-\d+|overflow-hidden|whitespace-nowrap)(\s|$)/;

/** The name element and its ancestors up to `root` never clip or ellipsise; `break-words` lets it wrap instead. */
function expectUnclipped(name: HTMLElement, root: HTMLElement = document.body) {
  for (let el: HTMLElement | null = name; el && el !== root; el = el.parentElement) {
    expect(el.className, `${el.tagName}.${el.className}`).not.toMatch(CLIPPING);
  }
  expect(name.className).toMatch(/break-words/);
  expect(name.style.textOverflow).not.toBe('ellipsis');
}

const holding = (symbol: string, name: string, weight: number): Holding => ({
  symbol,
  name,
  assetClass: 'ETF',
  sector: 'Diversified',
  country: 'Global',
  currency: 'EUR',
  quantity: 10,
  averageCostLocal: 100,
  priceLocal: 110,
  averageCostBase: 100,
  priceBase: 110,
  priceStale: false,
  costBasis: 1000,
  marketValue: 1100,
  unrealizedPnl: 100,
  unrealizedPnlPct: 10,
  currencyEffect: 0,
  dayChange: 1,
  dayChangePct: 0.1,
  realizedPnl: 0,
  dividendsReceived: 0,
  weight,
});

describe('benchmark picker shows the full names', () => {
  const options: GrowthBenchmarkOption[] = [
    { symbol: 'IWDA.AS', name: IWDA, hasData: true },
    { symbol: 'VWRL.AS', name: VWRL, hasData: true },
    { symbol: 'EXSA.DE', name: 'iShares STOXX Europe 600 UCITS ETF (DE)', hasData: false },
    { symbol: 'SXR8.DE', name: 'iShares Core S&P 500 UCITS ETF USD (Acc)', hasData: false },
    { symbol: 'NONAME', hasData: true },
  ];

  it('renders symbol and name in their own elements, the name wraps, and the status sits under the name', async () => {
    renderWithProviders(<BenchmarksBar selected={['IWDA.AS']} options={options} benchmarks={undefined} onChange={() => undefined} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Select' }));
    const list = screen.getByRole('group', { name: 'Benchmarks' });
    for (const o of options) {
      const label = within(list).getByRole('checkbox', { name: new RegExp(o.symbol) }).closest('label')!;
      const symbol = within(label).getByText(o.symbol);
      expect(symbol).toHaveClass('shrink-0');
      expectUnclipped(symbol, list);
      if (o.name) {
        const name = within(label).getByText(o.name, { exact: false });
        expect(name).toHaveTextContent(o.name);
        expectUnclipped(name, list);
        expect(label).toHaveTextContent(`${o.symbol} · ${o.name}`);
      }
    }
    const status = within(list).getAllByText('no price data yet');
    expect(status).toHaveLength(2);
    for (const s of status) expect(s.parentElement).toHaveTextContent(/UCITS ETF .*no price data yet$/);
    // the accessible name keeps the "symbol · name" form
    expect(within(list).getByRole('checkbox', { name: /^IWDA\.AS · iShares Core MSCI World UCITS ETF \(Acc\)/ })).toBeChecked();
    // an option without a name shows the bare symbol
    expect(within(list).getByRole('checkbox', { name: 'NONAME' })).toBeInTheDocument();
  });

  it('is wide enough for typical names but never wider than the viewport', async () => {
    renderWithProviders(<BenchmarksBar selected={[]} options={options} benchmarks={undefined} onChange={() => undefined} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Select' }));
    const panel = screen.getByRole('group', { name: 'Benchmarks' }).parentElement!;
    expect(panel.className).toContain('sm:w-[32rem]');
    expect(panel.className).toContain('inset-x-4');
    expect(panel.className).toContain('sm:max-w-[calc(100%-2rem)]');
  });
});

describe('watchlist rows show the full name', () => {
  it('wraps long names under the symbol', () => {
    const items: WatchlistItem[] = [
      { symbol: 'EMIM.AS', name: EMIM, addedAt: '2026-01-01T00:00:00.000Z', price: 33.12, currency: 'EUR', change: 0.1, changePct: 0.3 },
      { symbol: 'NEW', addedAt: '2026-01-02T00:00:00.000Z' },
    ];
    renderWithProviders(<WatchlistTable items={items} />);
    const row = screen.getByRole('rowheader', { name: new RegExp(EMIM.replaceAll(/[()]/g, String.raw`\$&`)) });
    const name = within(row).getByText(EMIM);
    expectUnclipped(name, row);
    expect(within(row).getByText('EMIM.AS')).toHaveClass('font-semibold');
    expect(within(screen.getByRole('rowheader', { name: 'NEW' })).queryByText(/UCITS/)).not.toBeInTheDocument();
  });
});

describe('holdings rows (table and mobile card) show the full name', () => {
  it('renders the complete name in both layouts without clipping classes', () => {
    renderWithProviders(<HoldingsTable holdings={[holding('VWRL.AS', VWRL, 0.6), holding('IWDA.AS', IWDA, 0.4)]} currency="EUR" />);
    for (const full of [VWRL, IWDA]) {
      const names = screen.getAllByText(full);
      expect(names).toHaveLength(2);
      for (const name of names) expectUnclipped(name);
    }
  });
});

describe('top movers show the full name', () => {
  it('wraps the name of every gainer and loser', async () => {
    const base: AnalyticsSummaryResponse = computeAnalyticsSummary(getAnalyticsData());
    const mover = (symbol: string, name: string) => ({ symbol, name, dayChange: 1, dayChangePct: 1 });
    server.use(
      http.get('/api/analytics/summary', () =>
        HttpResponse.json({ ...base, gainers: [mover('VWRL.AS', VWRL)], losers: [mover('IWDA.AS', IWDA)] }),
      ),
    );
    renderWithProviders(<MoversSection />);
    for (const full of [VWRL, IWDA]) expectUnclipped(await screen.findByText(full));
  });
});

describe('securities list and dashboard top holdings show the full name', () => {
  it('lists the complete names of the securities (table and cards)', async () => {
    renderWithProviders(<SecuritiesSection />, { route: '/assets?portfolio=all' });
    const names = await screen.findAllByText(VWRL);
    expect(names).toHaveLength(2);
    for (const name of names) expectUnclipped(name);
  });

  it('wraps the names of the top holdings', async () => {
    renderWithProviders(<DashboardPage />);
    const section = await screen.findByRole('region', { name: 'Top holdings' });
    const names = await within(section).findAllByText(/UCITS ETF|Inc\.|Corporation|Company|Cash/);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expectUnclipped(name, section);
  });
});
