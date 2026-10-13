import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import userEvent from '@testing-library/user-event';
import { TransactionForm, needsFxRate, validateTransaction } from './TransactionForm';
import { renderWithProviders } from '../../test/utils';
import { listTransactions } from '../../mocks/db';

describe('TransactionForm', () => {
  it('shows field errors from the shared schema and focuses the first invalid field', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderWithProviders(<TransactionForm onSuccess={onSuccess} />);

    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'EU');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));

    expect(screen.getByText('Symbol is required')).toBeInTheDocument();
    expect(screen.getByText('Quantity is required')).toBeInTheDocument();
    expect(screen.getByText('Price is required')).toBeInTheDocument();
    expect(screen.getByText('Use a 3-letter currency code (e.g. EUR)')).toBeInTheDocument();
    const symbol = screen.getByLabelText('Symbol');
    expect(symbol).toHaveAttribute('aria-invalid', 'true');
    expect(symbol).toHaveAccessibleDescription('Symbol is required');
    expect(symbol).toHaveFocus();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('rejects non-positive quantities, negative prices and bad symbols', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionForm />);
    await user.type(screen.getByLabelText('Symbol'), 'AA PL');
    await user.type(screen.getByLabelText('Quantity'), '0');
    await user.type(screen.getByLabelText('Price per unit'), '-5');
    await user.clear(screen.getByLabelText('Fee'));
    await user.type(screen.getByLabelText('Fee'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));

    expect(screen.getByText(/Use letters, digits/)).toBeInTheDocument();
    expect(screen.getByText('Quantity must be greater than 0')).toBeInTheDocument();
    expect(screen.getByText('Price cannot be negative')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid number')).toBeInTheDocument();
  });

  it('clears a field error when the field is edited', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionForm />);
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));
    expect(screen.getByText('Symbol is required')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Symbol'), 'A');
    expect(screen.queryByText('Symbol is required')).not.toBeInTheDocument();
  });

  it('submits a valid transaction (normalised by the schema) to POST /transactions', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderWithProviders(<TransactionForm onSuccess={onSuccess} />);

    await user.selectOptions(screen.getByLabelText('Type'), 'BUY');
    await user.type(screen.getByLabelText('Symbol'), 'asml.as');
    await user.type(screen.getByLabelText('Quantity'), '2');
    await user.type(screen.getByLabelText('Price per unit'), '700.5');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    const created = onSuccess.mock.calls[0]![0];
    expect(created).toMatchObject({ symbol: 'ASML.AS', quantity: 2, price: 700.5, fee: 0, currency: 'EUR', type: 'BUY' });
    expect(listTransactions().some((t) => t.id === created.id)).toBe(true);
  });

  it('surfaces API errors (e.g. overselling)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionForm />);
    await user.selectOptions(screen.getByLabelText('Type'), 'SELL');
    await user.type(screen.getByLabelText('Symbol'), 'KO');
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'USD');
    await user.type(screen.getByLabelText('Quantity'), '100000');
    await user.type(screen.getByLabelText('Price per unit'), '70');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Cannot sell 100000 KO/);
  });
});

describe('TransactionForm extras', () => {
  it('relabels quantity, price and fee for dividends', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionForm />);
    expect(screen.getByLabelText('Quantity')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Type'), 'DIVIDEND');
    expect(screen.getByLabelText('Eligible units')).toBeInTheDocument();
    expect(screen.getByLabelText('Gross dividend per unit')).toBeInTheDocument();
    expect(screen.getByLabelText('Withholding tax')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Dividend' })).toBeInTheDocument();
  });

  it('calls onCancel and only renders Cancel when provided', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const { unmount } = renderWithProviders(<TransactionForm onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
    renderWithProviders(<TransactionForm />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('shows a saving state, resets after success and keeps the note', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let posted: unknown;
    server.use(
      http.post('/api/transactions', async ({ request }) => {
        posted = await request.json();
        await gate;
        return HttpResponse.json({ ...(posted as object), id: 'new', userId: 'demo', createdAt: '2024-01-01T00:00:00Z' }, { status: 201 });
      }),
    );
    renderWithProviders(<TransactionForm />);
    await user.type(screen.getByLabelText('Symbol'), 'ko');
    await user.type(screen.getByLabelText('Quantity'), '3');
    await user.type(screen.getByLabelText('Price per unit'), '60');
    await user.type(screen.getByLabelText(/^Note/), '  First buy  ');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByLabelText('Symbol')).toHaveValue(''));
    expect(posted).toMatchObject({ symbol: 'KO', quantity: 3, price: 60, note: 'First buy' });
    expect(screen.getByLabelText(/^Note/)).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save transaction' })).toBeEnabled();
  });

  it('shows network errors from the server', async () => {
    const user = userEvent.setup();
    server.use(http.post('/api/transactions', () => HttpResponse.error()));
    renderWithProviders(<TransactionForm />);
    await user.type(screen.getByLabelText('Symbol'), 'KO');
    await user.type(screen.getByLabelText('Quantity'), '1');
    await user.type(screen.getByLabelText('Price per unit'), '1');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
  });

  it('reports a missing date and focuses it first', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionForm />);
    await user.clear(screen.getByLabelText('Date'));
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));
    expect(screen.getByText('Date is required')).toBeInTheDocument();
    expect(screen.getByLabelText('Date')).toHaveFocus();
  });
});

describe('TransactionForm FX rate', () => {
  it('defaults to EUR and only offers the FX rate for other currencies', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionForm />);
    expect(screen.getByLabelText('Currency')).toHaveValue('EUR');
    expect(screen.queryByLabelText(/FX rate/)).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'us');
    expect(screen.queryByLabelText(/FX rate/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Currency'), 'd');
    const fx = screen.getByLabelText('FX rate (USD per 1 EUR) (optional)');
    expect(fx).toHaveValue('');
    expect(fx).toHaveAccessibleDescription('From your broker statement. Leave empty to use the ECB rate of the trade date.');

    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'eur');
    expect(screen.queryByLabelText(/FX rate/)).not.toBeInTheDocument();
  });

  it('validates the FX rate with the shared schema and focuses it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionForm />);
    await user.type(screen.getByLabelText('Symbol'), 'KO');
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'USD');
    await user.type(screen.getByLabelText(/^FX rate/), '0');
    await user.type(screen.getByLabelText('Quantity'), '1');
    await user.type(screen.getByLabelText('Price per unit'), '60');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));

    const fx = screen.getByLabelText(/^FX rate/);
    expect(screen.getByText('FX rate must be greater than 0')).toBeInTheDocument();
    expect(fx).toHaveFocus();
    expect(fx).toHaveAttribute('aria-invalid', 'true');
    expect(fx).toHaveAccessibleDescription(
      'From your broker statement. Leave empty to use the ECB rate of the trade date. FX rate must be greater than 0',
    );

    await user.clear(fx);
    await user.type(fx, 'abc');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));
    expect(screen.getByText('Enter a valid number')).toBeInTheDocument();
  });

  it('submits the broker FX rate, accepting a Dutch decimal comma', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderWithProviders(<TransactionForm onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText('Symbol'), 'ko');
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'usd');
    await user.type(screen.getByLabelText(/^FX rate/), '1,0842');
    await user.type(screen.getByLabelText('Quantity'), '3');
    await user.type(screen.getByLabelText('Price per unit'), '61,25');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess.mock.calls[0]![0]).toMatchObject({ symbol: 'KO', currency: 'USD', quantity: 3, price: 61.25, fxRate: 1.0842 });
    expect(screen.getByLabelText('Currency')).toHaveValue('EUR');
    expect(screen.queryByLabelText(/FX rate/)).not.toBeInTheDocument();
  });

  it('leaves the FX rate out when it is empty', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderWithProviders(<TransactionForm onSuccess={onSuccess} />);
    await user.type(screen.getByLabelText('Symbol'), 'KO');
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'USD');
    await user.type(screen.getByLabelText('Quantity'), '1');
    await user.type(screen.getByLabelText('Price per unit'), '60');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess.mock.calls[0]![0]).not.toHaveProperty('fxRate');
  });
});

describe('needsFxRate', () => {
  it.each([
    ['USD', true],
    [' gbp ', true],
    ['EUR', false],
    ['eur', false],
    ['US', false],
    ['', false],
  ])('%j → %s', (currency, expected) => {
    expect(needsFxRate(currency)).toBe(expected);
  });
});

describe('validateTransaction', () => {
  const valid = { date: '2024-01-02', type: 'BUY', symbol: 'KO', quantity: '1', price: '1', fee: '0', currency: 'USD', note: '' };

  it.each([
    ['symbol', { symbol: 'A'.repeat(21) }, 'Symbol is too long (max 20 characters)'],
    ['symbol', { symbol: '   ' }, 'Symbol is required'],
    ['quantity', { quantity: 'many' }, 'Enter a valid number'],
    ['quantity', { quantity: '-1' }, 'Quantity must be greater than 0'],
    ['price', { price: 'free' }, 'Enter a valid number'],
    ['fee', { fee: '-1' }, 'Fee cannot be negative'],
    ['note', { note: 'x'.repeat(501) }, 'Note is too long (max 500 characters)'],
    ['type', { type: 'HOLD' }, expect.stringMatching(/Invalid enum value/)],
    ['date', { date: '' }, 'Date is required'],
    ['date', { date: '2024-02-30' }, 'Enter a date as YYYY-MM-DD'],
  ] as const)('maps %s errors to friendly messages (%j)', (field, patch, message) => {
    const res = validateTransaction({ ...valid, ...patch });
    expect(res.data).toBeUndefined();
    expect(res.errors[field]).toEqual(message);
  });


  it('returns parsed data for valid input', () => {
    const res = validateTransaction({
      date: '2024-01-02', type: 'DIVIDEND', symbol: ' ko ', quantity: '10', price: '0.485', fee: '', currency: 'usd', note: '  ',
    });
    expect(res.errors).toEqual({});
    expect(res.data).toEqual({ date: '2024-01-02', type: 'DIVIDEND', symbol: 'KO', quantity: 10, price: 0.485, fee: 0, currency: 'USD' });
  });

  it('parses an optional FX rate for foreign-currency trades and drops it for EUR trades', () => {
    expect(validateTransaction({ ...valid, fxRate: '1.0842' }).data).toMatchObject({ currency: 'USD', fxRate: 1.0842 });
    expect(validateTransaction({ ...valid, fxRate: ' 1,1 ' }).data).toMatchObject({ fxRate: 1.1 });
    expect(validateTransaction({ ...valid, fxRate: '' }).data).not.toHaveProperty('fxRate');
    expect(validateTransaction({ ...valid, currency: 'EUR', fxRate: '1.2' }).data).not.toHaveProperty('fxRate');
    expect(validateTransaction({ ...valid, fxRate: '-1' }).errors.fxRate).toBe('FX rate must be greater than 0');
    expect(validateTransaction({ ...valid, fxRate: 'x' }).errors.fxRate).toBe('Enter a valid number');
  });

  it('accepts Dutch decimal commas and thousands separators', () => {
    expect(validateTransaction({ ...valid, quantity: '1.000,5', price: '0,485', fee: '1,50' }).data).toMatchObject({
      quantity: 1000.5,
      price: 0.485,
      fee: 1.5,
    });
  });

  it('reports a malformed date', () => {
    const res = validateTransaction({
      date: '02/01/2024', type: 'BUY', symbol: 'KO', quantity: '1', price: '1', fee: '0', currency: 'USD', note: '',
    });
    expect(res.errors.date).toBe('Enter a date as YYYY-MM-DD');
  });
});
