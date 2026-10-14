import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CsvImport } from './CsvImport';
import { renderWithProviders } from '../../test/utils';
import { listTransactions, resetDb } from '../../mocks/db';

const HEADER =
  'Action,Time (UTC),ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Total,Currency (Total),Withholding tax,Currency (Withholding tax),Currency conversion fee,Currency (Currency conversion fee)';
const BUY = 'Market buy,2026-01-05 10:00:00.123,US0378331005,AAPL,Apple,,ID1,2,100,USD,1.1,181.99,EUR,,,0.27,EUR';
const DEPOSIT = 'Deposit,2026-01-01 09:00:00,,,,,ID0,,,,,100,EUR,,,,';
const AMBIGUOUS = 'Market buy,2026-01-06 10:00:00,IE00B3RBWM25,VWRL,Vanguard,,ID2,1,100,EUR,1,100,EUR,,,,';

const upload = async (rows: string[]) => {
  const user = userEvent.setup();
  renderWithProviders(<CsvImport pollIntervalMs={5} />);
  await user.upload(screen.getByLabelText('CSV file'), new File([[HEADER, ...rows].join('\n')], 'history.csv', { type: 'text/csv' }));
  await user.click(screen.getByRole('button', { name: 'Upload & import' }));
};

describe('CsvImport with a Trading 212 export', () => {
  it('mentions the preset next to the header help', () => {
    renderWithProviders(<CsvImport />);
    expect(screen.getByTestId('csv-trading212-help')).toHaveTextContent('Trading 212 "History" exports');
  });

  it('converts in the browser, imports trades and explains what was skipped', async () => {
    resetDb({ empty: true });
    await upload([BUY, DEPOSIT, AMBIGUOUS]);
    expect(await screen.findByText('✓ Import completed')).toBeInTheDocument();
    const notes = screen.getByTestId('trading212-conversion');
    expect(notes).toHaveTextContent('Trading 212 export recognised: 1 trade/dividend rows converted.');
    expect(notes).toHaveTextContent('Skipped 1 other rows (Deposit ×1).');
    expect(notes).toHaveTextContent('Not imported, market could not be determined: VWRL ×1.');
    expect(listTransactions()).toEqual([expect.objectContaining({ symbol: 'AAPL', type: 'BUY', quantity: 2, price: 100, currency: 'USD', fxRate: 1.1 })]);
  });

  it('does not upload an export without importable rows', async () => {
    resetDb({ empty: true });
    await upload([DEPOSIT]);
    expect(await screen.findByRole('alert')).toHaveTextContent('contains no trades or dividends that could be imported');
    expect(listTransactions()).toHaveLength(0);
  });

  it('leaves ordinary imports without conversion notes', async () => {
    resetDb({ empty: true });
    const user = userEvent.setup();
    renderWithProviders(<CsvImport pollIntervalMs={5} />);
    const csv = 'date,type,symbol,quantity,price,fee,currency,note,fxRate\n2024-01-02,BUY,AAPL,1,100,0,USD,,';
    await user.upload(screen.getByLabelText('CSV file'), new File([csv], 'mine.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));
    expect(await screen.findByText('✓ Import completed')).toBeInTheDocument();
    expect(screen.queryByTestId('trading212-conversion')).toBeNull();
  });

  it('notes that failed-row numbers refer to the converted rows', async () => {
    resetDb({ empty: true });
    // Selling shares that were never bought fails validation in the (mock) ingest.
    await upload(['Market sell,2026-01-05 10:00:00,US0378331005,AAPL,Apple,,ID9,5,100,USD,1.1,454,EUR,,,0.5,EUR']);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Import failed');
    expect(within(alert).getByText(/Row numbers refer to the converted Trading 212 rows/)).toBeInTheDocument();
  });
});
