import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Holding } from '@portfolio/shared';
import { CURRENCY_EFFECT_HINT, HoldingsTable } from './HoldingsTable';
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
  averageCostBase: 92,
  priceBase: 94,
  priceStale: false,
  costBasis: 900,
  currencyEffect: -12,
  dayChange: 1,
  dayChangePct: 0.1,
  realizedPnl: 0,
  dividendsReceived: 0,
};

/** A holding that trades in the base currency: local and EUR amounts coincide, no currency effect. */
const eur = { currency: 'EUR', currencyEffect: 0 } as const;

const holdings: Holding[] = [
  { ...base, symbol: 'MSFT', name: 'Microsoft', marketValue: 2000, unrealizedPnl: 300, unrealizedPnlPct: 17.6, weight: 0.5 },
  { ...base, symbol: 'AAPL', name: 'Apple', marketValue: 1500, unrealizedPnl: -100, unrealizedPnlPct: -6.25, weight: 0.375 },
  { ...base, ...eur, symbol: 'VWRL.AS', name: 'Vanguard All-World', averageCostBase: 100, priceBase: 110, marketValue: 500, unrealizedPnl: 50, unrealizedPnlPct: 11.1, weight: 0.125, priceStale: true },
];

const varied: Holding[] = [
  { ...base, symbol: 'AAA', name: 'Alpha', quantity: 5, averageCostLocal: 50, priceLocal: 0.5, averageCostBase: 45, priceBase: 0.45, currencyEffect: -3, marketValue: 300, unrealizedPnl: 30, unrealizedPnlPct: 5, dayChange: -2, dayChangePct: -0.5, weight: 0.3 },
  { ...base, ...eur, symbol: 'BBB', name: 'Beta', quantity: 20, averageCostLocal: 10, priceLocal: 30, averageCostBase: 10, priceBase: 30, marketValue: 600, unrealizedPnl: -50, unrealizedPnlPct: -10, dayChange: 4, dayChangePct: 2, weight: 0.6 },
  { ...base, symbol: 'CCC', name: 'Gamma', quantity: 10, averageCostLocal: 200, priceLocal: 2, averageCostBase: 180, priceBase: 1.8, currencyEffect: 5, marketValue: 100, unrealizedPnl: 0, unrealizedPnlPct: 0, dayChange: 1, dayChangePct: 0.1, weight: 0.1 },
];

const M = '\u2212';

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
    expect(within(aaplRow).getByText(`€ ${M}100,00`)).toBeInTheDocument();
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
      ['Avg cost', 'averageCostBase', ['CCC', 'AAA', 'BBB']],
      ['Price', 'priceBase', ['BBB', 'CCC', 'AAA']],
      ['Market value', 'marketValue', ['BBB', 'AAA', 'CCC']],
      ['Unrealized P&L', 'unrealizedPnl', ['AAA', 'CCC', 'BBB']],
      ['P&L %', 'unrealizedPnlPct', ['AAA', 'CCC', 'BBB']],
      ['Currency effect', 'currencyEffect', ['CCC', 'BBB', 'AAA']],
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

  it('shows avg cost and price in EUR first, with the trading-currency amount underneath for foreign holdings', () => {
    renderWithProviders(<HoldingsTable holdings={holdings} currency="EUR" />);
    const table = screen.getByRole('table');
    const cells = (symbol: string) => within(within(table).getByRole('rowheader', { name: new RegExp(symbol) }).closest('tr')!).getAllByRole('cell');
    const [, msftAvg, msftPrice] = cells('MSFT');
    expect(msftAvg).toHaveTextContent('€ 92,00US$ 100,00');
    expect(msftPrice).toHaveTextContent('€ 94,00US$ 110,00');
    expect(within(msftPrice!).getByText('US$ 110,00')).toHaveAttribute('title', 'In USD, the trading currency');
    const [, vwrlAvg, vwrlPrice] = cells('VWRL.AS');
    expect(vwrlAvg).toHaveTextContent(/^€ 100,00$/);
    expect(vwrlPrice).toHaveTextContent(/^€ 110,00$/);
  });

  it('shows the currency effect with sign and arrow, and a dash for euro holdings', () => {
    renderWithProviders(<HoldingsTable holdings={varied} currency="EUR" />);
    const table = screen.getByRole('table');
    const effectCell = (symbol: string) => within(within(table).getByRole('rowheader', { name: new RegExp(symbol) }).closest('tr')!).getAllByRole('cell')[6]!;
    expect(effectCell('AAA')).toHaveTextContent(`down€ ${M}3,00`);
    expect(effectCell('CCC')).toHaveTextContent('up€ +5,00');
    expect(within(effectCell('CCC')).getByTitle(CURRENCY_EFFECT_HINT)).toBeInTheDocument();
    expect(effectCell('BBB')).toHaveTextContent('—none');
    expect(within(effectCell('BBB')).getByTitle('No currency effect: BBB trades in EUR')).toBeInTheDocument();

    const header = screen.getByRole('button', { name: 'Currency effect' });
    expect(header).toHaveAttribute('title', CURRENCY_EFFECT_HINT);
    expect(header).toHaveAccessibleDescription(expect.stringContaining('Currency effect: the part of the unrealized P&L caused by exchange-rate moves'));
    expect(screen.getByRole('button', { name: 'Weight' })).not.toHaveAttribute('title');
    expect(screen.getByRole('button', { name: 'Weight' })).not.toHaveAttribute('aria-describedby');
  });

  it('uses 6 decimals for sub-unit prices', () => {
    renderWithProviders(<HoldingsTable holdings={varied} currency="EUR" />);
    const row = within(screen.getByRole('table')).getByRole('rowheader', { name: /AAA/ }).closest('tr')!;
    expect(within(row).getByText('€ 0,45')).toBeInTheDocument();
    expect(within(row).getByText('US$ 0,50')).toBeInTheDocument();
    expect(within(row).getByText('€ 45,00')).toBeInTheDocument();
    expect(within(row).getByText('US$ 50,00')).toBeInTheDocument();
    const cheap = [{ ...varied[0]!, priceLocal: 0.123456, averageCostLocal: 0.1, priceBase: 0.111111, averageCostBase: 0.09 }];
    renderWithProviders(<HoldingsTable holdings={cheap} currency="EUR" />);
    expect(screen.getAllByText('US$ 0,123456').length).toBeGreaterThan(0);
    expect(screen.getAllByText('€ 0,111111').length).toBeGreaterThan(0);
  });

  it('renders a mobile card list with its own sort selector and stale indicator', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HoldingsTable holdings={[...varied, { ...varied[2]!, symbol: 'DDD', name: 'Stale Co', priceStale: true, weight: 0.05, marketValue: 50 }]} currency="EUR" />);
    const list = screen.getByRole('list', { name: 'Holdings' });
    const cardSymbols = () => within(list).getAllByRole('listitem').map((li) => li.querySelector('span.font-semibold')?.textContent);
    expect(cardSymbols()).toEqual(['BBB', 'AAA', 'CCC', 'DDD']);

    const bbb = within(list).getAllByRole('listitem')[0]!;
    expect(bbb).toHaveTextContent('€ 600,00');
    expect(bbb).toHaveTextContent('60,0% of portfolio');
    expect(within(bbb).getByText('Quantity').nextSibling).toHaveTextContent('20');
    expect(within(bbb).getByText('Price').nextSibling).toHaveTextContent(/^€ 30,00$/);
    expect(within(bbb).getByText('Avg cost').nextSibling).toHaveTextContent(/^€ 10,00$/);
    expect(within(bbb).getByText('Unrealized P&L').nextSibling).toHaveTextContent(`€ ${M}50,00(${M}10,00%)`);
    expect(within(bbb).getByText('Currency effect').nextSibling).toHaveTextContent('—none');
    expect(within(bbb).getByText('Day change').nextSibling).toHaveTextContent('€ +4,00(+2,00%)');
    expect(within(bbb).queryByText(/stale price/i)).not.toBeInTheDocument();
    const aaa = within(list).getAllByRole('listitem')[1]!;
    expect(within(aaa).getByText('Price').nextSibling).toHaveTextContent('€ 0,45US$ 0,50');
    expect(within(aaa).getByText('Avg cost').nextSibling).toHaveTextContent('€ 45,00US$ 50,00');
    expect(within(aaa).getByText('Currency effect').nextSibling).toHaveTextContent(`€ ${M}3,00`);
    const ddd = within(list).getAllByRole('listitem')[3]!;
    expect(within(ddd).getByText(/stale price/i)).toHaveAttribute('title', 'The latest price could not be refreshed; the last known price is shown.');

    const select = screen.getByLabelText('Sort by');
    expect(within(select).getAllByRole('option')).toHaveLength(20);
    expect(within(select).getByRole('option', { name: 'Holding (A–Z)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Weight (low–high)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Currency effect (high–low)' })).toBeInTheDocument();

    await user.selectOptions(select, 'symbol:desc');
    expect(cardSymbols()).toEqual(['DDD', 'CCC', 'BBB', 'AAA']);
    await user.selectOptions(select, 'Weight (low–high)');
    expect(cardSymbols()).toEqual(['DDD', 'CCC', 'AAA', 'BBB']);
    // The desktop table follows the same sort state.
    expect(screen.getByRole('columnheader', { name: 'Weight' })).toHaveAttribute('aria-sort', 'ascending');
    await user.selectOptions(select, 'currencyEffect:asc');
    expect(cardSymbols()).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
  });

  it('explains EUR-first amounts and the currency effect in a footnote', () => {
    renderWithProviders(<HoldingsTable holdings={holdings} currency="EUR" />);
    expect(screen.getByText(/^Avg cost and price are in EUR \(purchase-date and today's exchange rates\)/)).toHaveTextContent(
      'Currency effect: the part of the unrealized P&L caused by exchange-rate moves since purchase',
    );
  });
});

describe('sortHoldings', () => {
  it('breaks ties alphabetically regardless of direction', () => {
    const tied = holdings.map((h) => ({ ...h, quantity: 1 }));
    expect(sortHoldings(tied, 'quantity', 'desc').map((h) => h.symbol)).toEqual(['AAPL', 'MSFT', 'VWRL.AS']);
    expect(sortHoldings(tied, 'quantity', 'asc').map((h) => h.symbol)).toEqual(['AAPL', 'MSFT', 'VWRL.AS']);
  });

  it('sorts avg cost and price on the EUR values, not the local ones', () => {
    const x: Holding = { ...holdings[0]!, symbol: 'X', currency: 'USD', averageCostLocal: 100, averageCostBase: 85, priceLocal: 120, priceBase: 100 };
    const y: Holding = { ...holdings[2]!, symbol: 'Y', averageCostLocal: 90, averageCostBase: 90, priceLocal: 105, priceBase: 105 };
    expect(sortHoldings([x, y], 'averageCostBase', 'desc').map((h) => h.symbol)).toEqual(['Y', 'X']);
    expect(sortHoldings([x, y], 'priceBase', 'desc').map((h) => h.symbol)).toEqual(['Y', 'X']);
  });

  it('does not mutate its input', () => {
    const input = [...holdings];
    sortHoldings(input, 'symbol', 'asc');
    expect(input.map((h) => h.symbol)).toEqual(['MSFT', 'AAPL', 'VWRL.AS']);
  });
});

