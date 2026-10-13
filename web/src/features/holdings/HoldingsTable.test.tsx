import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Holding } from '@portfolio/shared';
import { HoldingsTable } from './HoldingsTable';
import { HoldingsPage } from '../../pages/HoldingsPage';
import { renderWithProviders } from '../../test/utils';

const base: Omit<Holding, 'symbol' | 'name' | 'marketValue' | 'unrealizedPnl' | 'unrealizedPnlPct' | 'weight'> = {
  assetClass: 'STOCK',
  sector: 'Technology',
  country: 'United States',
  currency: 'USD',
  quantity: 10,
  averageCostLocal: 100,
  priceLocal: 110,
  priceStale: false,
  costBasis: 900,
  dayChange: 1,
  dayChangePct: 0.1,
  realizedPnl: 0,
  dividendsReceived: 0,
};

const holdings: Holding[] = [
  { ...base, symbol: 'MSFT', name: 'Microsoft', marketValue: 2000, unrealizedPnl: 300, unrealizedPnlPct: 17.6, weight: 0.5 },
  { ...base, symbol: 'AAPL', name: 'Apple', marketValue: 1500, unrealizedPnl: -100, unrealizedPnlPct: -6.25, weight: 0.375 },
  { ...base, symbol: 'VWRL.AS', name: 'Vanguard All-World', currency: 'EUR', marketValue: 500, unrealizedPnl: 50, unrealizedPnlPct: 11.1, weight: 0.125, priceStale: true },
];

const rowSymbols = () => {
  const table = screen.getByRole('table');
  return within(table)
    .getAllByRole('rowheader')
    .map((th) => th.querySelector('span.font-semibold')?.textContent);
};

describe('HoldingsTable', () => {
  it('sorts by market value descending by default', () => {
    renderWithProviders(<HoldingsTable holdings={holdings} currency="EUR" />);
    expect(rowSymbols()).toEqual(['MSFT', 'AAPL', 'VWRL.AS']);
    expect(screen.getByRole('columnheader', { name: /market value/i })).toHaveAttribute('aria-sort', 'descending');
  });

  it('toggles sort direction and switches columns', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HoldingsTable holdings={holdings} currency="EUR" />);

    await user.click(screen.getByRole('button', { name: /^Holding/ }));
    expect(rowSymbols()).toEqual(['AAPL', 'MSFT', 'VWRL.AS']);
    expect(screen.getByRole('columnheader', { name: /^Holding/ })).toHaveAttribute('aria-sort', 'ascending');

    await user.click(screen.getByRole('button', { name: /^Holding/ }));
    expect(rowSymbols()).toEqual(['VWRL.AS', 'MSFT', 'AAPL']);

    await user.click(screen.getByRole('button', { name: /^P&L %/ }));
    expect(rowSymbols()).toEqual(['MSFT', 'VWRL.AS', 'AAPL']);
    await user.click(screen.getByRole('button', { name: /^P&L %/ }));
    expect(rowSymbols()).toEqual(['AAPL', 'VWRL.AS', 'MSFT']);
    expect(screen.getByRole('columnheader', { name: /market value/i })).toHaveAttribute('aria-sort', 'none');
  });

  it('flags stale prices and signs losses', () => {
    renderWithProviders(<HoldingsTable holdings={holdings} currency="EUR" />);
    const table = screen.getByRole('table');
    const vwrlRow = within(table).getByRole('rowheader', { name: /VWRL\.AS/ }).closest('tr')!;
    expect(within(vwrlRow).getByText(/stale price/i)).toBeInTheDocument();
    const aaplRow = within(table).getByRole('rowheader', { name: /AAPL/ }).closest('tr')!;
    expect(within(aaplRow).getByText('\u2212€100.00')).toBeInTheDocument();
    expect(within(aaplRow).getAllByText('down').length).toBeGreaterThan(0);
  });

  it('loads holdings from the API on the holdings page', async () => {
    renderWithProviders(<HoldingsPage />);
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('rowheader')).toHaveLength(8);
    expect(within(table).getByText('BTC-EUR')).toBeInTheDocument();
  });
});
