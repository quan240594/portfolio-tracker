import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TransactionForm, validateTransaction } from './TransactionForm';
import { renderWithProviders } from '../../test/utils';
import { listTransactions } from '../../mocks/db';

const base = { portfolioId: 'default', date: '2026-01-05', type: 'BUY', symbol: 'ASML.AS', quantity: '1', price: '10', fee: '0', currency: 'EUR', note: '' };

describe('validateTransaction (management types)', () => {
  it('derives the symbol of cash movements and fixes price and fee', () => {
    const { data, errors } = validateTransaction({ ...base, type: 'DEPOSIT', symbol: '', quantity: '1.500,50', price: '', fee: '3' });
    expect(errors).toEqual({});
    expect(data).toMatchObject({ type: 'DEPOSIT', symbol: 'CASH.EUR', quantity: 1500.5, price: 1, fee: 0 });
  });

  it('reports a bad currency of a cash movement on the currency field', () => {
    expect(validateTransaction({ ...base, type: 'INTEREST', symbol: '', currency: 'E' }).errors).toEqual({
      currency: 'Use a 3-letter currency code (e.g. EUR)',
    });
  });

  it('accepts a split with a ratio and rejects a missing or zero ratio', () => {
    expect(validateTransaction({ ...base, type: 'SPLIT', price: '', quantity: '0,1' }).data).toMatchObject({ type: 'SPLIT', quantity: 0.1, price: 0, fee: 0 });
    expect(validateTransaction({ ...base, type: 'SPLIT', quantity: '0' }).errors.quantity).toBe('Quantity must be greater than 0');
  });
});

describe('TransactionForm (management types)', () => {
  it('records a cash deposit without symbol, price or fee fields', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderWithProviders(<TransactionForm onSuccess={onSuccess} />);
    await user.selectOptions(screen.getByLabelText('Type'), 'DEPOSIT');
    expect(screen.queryByLabelText('Symbol')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Price per unit')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Fee')).not.toBeInTheDocument();
    expect(screen.getByText(/only count when cash tracking is switched on/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Amount'), '250');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(listTransactions()[0]).toMatchObject({ type: 'DEPOSIT', symbol: 'CASH.EUR', quantity: 250, price: 1, fee: 0 });
  });

  it('records a stock split with an explanation of the ratio', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderWithProviders(<TransactionForm onSuccess={onSuccess} />);
    await user.selectOptions(screen.getByLabelText('Type'), 'SPLIT');
    expect(screen.getByLabelText('New shares per old share')).toHaveAccessibleDescription(/4 for a 4-for-1 split/);
    await user.type(screen.getByLabelText('Symbol'), 'ASML.AS');
    await user.type(screen.getByLabelText('New shares per old share'), '2');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(listTransactions()[0]).toMatchObject({ type: 'SPLIT', symbol: 'ASML.AS', quantity: 2 });
  });

  it('shows the server error for a split without a position', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionForm />);
    await user.selectOptions(screen.getByLabelText('Type'), 'SPLIT');
    await user.type(screen.getByLabelText('Symbol'), 'NOPE');
    await user.type(screen.getByLabelText('New shares per old share'), '2');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Cannot split NOPE/);
  });

  it('computes the dividend withholding tax from the portfolio default rate until edited', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderWithProviders(<TransactionForm onSuccess={onSuccess} />);
    await user.selectOptions(screen.getByLabelText('Type'), 'DIVIDEND');
    await user.type(screen.getByLabelText('Symbol'), 'ASML.AS');
    await user.type(screen.getByLabelText('Eligible units'), '10');
    await user.type(screen.getByLabelText('Gross dividend per unit'), '0,5');
    const fee = await screen.findByLabelText('Withholding tax');
    await waitFor(() => expect(fee).toHaveValue('0.75'));
    expect(fee).toHaveAccessibleDescription(/default 15% of the gross dividend/);

    await user.clear(fee);
    await user.type(fee, '1');
    await user.clear(screen.getByLabelText('Gross dividend per unit'));
    await user.type(screen.getByLabelText('Gross dividend per unit'), '1');
    expect(fee).toHaveValue('1');
    await user.click(screen.getByRole('button', { name: 'Save transaction' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(listTransactions()[0]).toMatchObject({ type: 'DIVIDEND', symbol: 'ASML.AS', fee: 1 });
  });

  it('leaves the fee alone when the portfolio has no default rate', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionForm />, { route: '/transactions?portfolio=trading-212' });
    await user.selectOptions(screen.getByLabelText('Type'), 'DIVIDEND');
    await user.type(screen.getByLabelText('Eligible units'), '10');
    await user.type(screen.getByLabelText('Gross dividend per unit'), '2');
    expect(screen.getByLabelText('Withholding tax')).toHaveValue('0');
    expect(screen.getByLabelText('Withholding tax')).not.toHaveAccessibleDescription();
  });

  it('shows the plain fee until quantity and price are known', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TransactionForm />);
    await user.selectOptions(screen.getByLabelText('Type'), 'DIVIDEND');
    expect(await screen.findByLabelText('Withholding tax')).toHaveAccessibleDescription(/default 15%/);
    expect(screen.getByLabelText('Withholding tax')).toHaveValue('0');
  });
});
