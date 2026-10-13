import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Holding } from '@portfolio/shared';
import { HoldingsTable } from './HoldingsTable';
import { HoldingsPage } from '../../pages/HoldingsPage';
import { renderWithProviders } from '../../test/utils';
import { sortHoldings, type SortKey } from './sortHoldings';

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

const varied: Holding[] = [
  { ...base, symbol: 'AAA', name: 'Alpha', quantity: 5, averageCostLocal: 50, priceLocal: 0.5, marketValue: 300, unrealizedPnl: 30, unrealizedPnlPct: 5, dayChange: -2, dayChangePct: -0.5, weight: 0.3 },
  { ...base, symbol: 'BBB', name: 'Beta', currency: 'EUR', quantity: 20, averageCostLocal: 10, priceLocal: 30, marketValue: 600, unrealizedPnl: -50, unrealizedPnlPct: -10, dayChange: 4, dayChangePct: 2, weight: 0.6 },
  { ...base, symbol: 'CCC', name: 'Gamma', quantity: 10, averageCostLocal: 200, priceLocal: 2, marketValue: 100, unrealizedPnl: 0, unrealizedPnlPct: 0, dayChange: 1, dayChangePct: 0.1, weight: 0.1 },
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

  it('sorts by every column, toggling direction on repeated clicks', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HoldingsTable holdings={varied} currency="EUR" />);
    const columns: [string, SortKey, string[]][] = [
      ['Holding', 'symbol', ['AAA', 'BBB', 'CCC']],
      ['Quantity', 'quantity', ['BBB', 'CCC', 'AAA']],
      ['Avg cost', 'averageCostLocal', ['CCC', 'AAA', 'BBB']],
      ['Price', 'priceLocal', ['BBB', 'CCC', 'AAA']],
      ['Market value', 'marketValue', ['BBB', 'AAA', 'CCC']],
      ['Unrealized P&L', 'unrealizedPnl', ['AAA', 'CCC', 'BBB']],
      ['P&L %', 'unrealizedPnlPct', ['AAA', 'CCC', 'BBB']],
      ['Day change', 'dayChange', ['BBB', 'CCC', 'AAA']],
      ['Weight', 'weight', ['BBB', 'AAA', 'CCC']],
    ];
    for (const [label, key, first] of columns) {
      const firstDir = key === 'symbol' ? 'ascending' : 'descending';
      const secondDir = key === 'symbol' ? 'descending' : 'ascending';
      await user.click(screen.getByRole('button', { name: label }));
      expect(rowSymbols()).toEqual(first);
      expect(screen.getByRole('columnheader', { name: label })).toHaveAttribute('aria-sort', firstDir);
      expect(screen.getByRole('table', { name: `Holdings, sorted by ${label} ${firstDir}` })).toBeInTheDocument();
      expect(screen.getByLabelText('Sort by')).toHaveValue(`${key}:${firstDir === 'ascending' ? 'asc' : 'desc'}`);

      await user.click(screen.getByRole('button', { name: label }));
      expect(rowSymbols()).toEqual([...first].reverse());
      expect(screen.getByRole('columnheader', { name: label })).toHaveAttribute('aria-sort', secondDir);
      expect(screen.getAllByRole('columnheader').filter((th) => th.getAttribute('aria-sort') !== 'none')).toHaveLength(1);
    }
  });

  it('uses 6 decimals for sub-unit prices', () => {
    renderWithProviders(<HoldingsTable holdings={varied} currency="EUR" />);
    const row = within(screen.getByRole('table')).getByRole('rowheader', { name: /AAA/ }).closest('tr')!;
    expect(within(row).getByText('US$0.50')).toBeInTheDocument();
    expect(within(row).getByText('US$50.00')).toBeInTheDocument();
    const cheap = [{ ...varied[0]!, priceLocal: 0.123456, averageCostLocal: 0.1 }];
    renderWithProviders(<HoldingsTable holdings={cheap} currency="EUR" />);
    expect(screen.getAllByText('US$0.123456').length).toBeGreaterThan(0);
  });

  it('renders a mobile card list with its own sort selector and stale indicator', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HoldingsTable holdings={[...varied, { ...varied[2]!, symbol: 'DDD', name: 'Stale Co', priceStale: true, weight: 0.05, marketValue: 50 }]} currency="EUR" />);
    const list = screen.getByRole('list', { name: 'Holdings' });
    const cardSymbols = () => within(list).getAllByRole('listitem').map((li) => li.querySelector('span.font-semibold')?.textContent);
    expect(cardSymbols()).toEqual(['BBB', 'AAA', 'CCC', 'DDD']);

    const bbb = within(list).getAllByRole('listitem')[0]!;
    expect(bbb).toHaveTextContent('€600.00');
    expect(bbb).toHaveTextContent('60.0% of portfolio');
    expect(within(bbb).getByText('Quantity').nextSibling).toHaveTextContent('20');
    expect(within(bbb).getByText('Price / avg cost').nextSibling).toHaveTextContent('€30.00 / €10.00');
    expect(within(bbb).getByText('Unrealized P&L').nextSibling).toHaveTextContent('\u2212€50.00(\u221210.00%)');
    expect(within(bbb).getByText('Day change').nextSibling).toHaveTextContent('+€4.00(+2.00%)');
    expect(within(bbb).queryByText(/stale price/i)).not.toBeInTheDocument();
    const ddd = within(list).getAllByRole('listitem')[3]!;
    expect(within(ddd).getByText(/stale price/i)).toHaveAttribute('title', 'The latest price could not be refreshed; the last known price is shown.');

    const select = screen.getByLabelText('Sort by');
    expect(within(select).getAllByRole('option')).toHaveLength(18);
    expect(within(select).getByRole('option', { name: 'Holding (A–Z)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Weight (low–high)' })).toBeInTheDocument();

    await user.selectOptions(select, 'symbol:desc');
    expect(cardSymbols()).toEqual(['DDD', 'CCC', 'BBB', 'AAA']);
    await user.selectOptions(select, 'Weight (low–high)');
    expect(cardSymbols()).toEqual(['DDD', 'CCC', 'AAA', 'BBB']);
    // The desktop table follows the same sort state.
    expect(screen.getByRole('columnheader', { name: 'Weight' })).toHaveAttribute('aria-sort', 'ascending');
  });
});

describe('sortHoldings', () => {
  it('breaks ties alphabetically regardless of direction', () => {
    const tied = holdings.map((h) => ({ ...h, quantity: 1 }));
    expect(sortHoldings(tied, 'quantity', 'desc').map((h) => h.symbol)).toEqual(['AAPL', 'MSFT', 'VWRL.AS']);
    expect(sortHoldings(tied, 'quantity', 'asc').map((h) => h.symbol)).toEqual(['AAPL', 'MSFT', 'VWRL.AS']);
  });

  it('does not mutate its input', () => {
    const input = [...holdings];
    sortHoldings(input, 'symbol', 'asc');
    expect(input.map((h) => h.symbol)).toEqual(['MSFT', 'AAPL', 'VWRL.AS']);
  });
});

