import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TransactionForm, validateTransaction } from './TransactionForm';
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

describe('validateTransaction', () => {
  it('returns parsed data for valid input', () => {
    const res = validateTransaction({
      date: '2024-01-02', type: 'DIVIDEND', symbol: ' ko ', quantity: '10', price: '0.485', fee: '', currency: 'usd', note: '  ',
    });
    expect(res.errors).toEqual({});
    expect(res.data).toEqual({ date: '2024-01-02', type: 'DIVIDEND', symbol: 'KO', quantity: 10, price: 0.485, fee: 0, currency: 'USD' });
  });

  it('reports a malformed date', () => {
    const res = validateTransaction({
      date: '02/01/2024', type: 'BUY', symbol: 'KO', quantity: '1', price: '1', fee: '0', currency: 'USD', note: '',
    });
    expect(res.errors.date).toBe('Enter a date as YYYY-MM-DD');
  });
});
