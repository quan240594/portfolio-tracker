import { useRef, useState, type FormEvent } from 'react';
import { TRANSACTION_TYPES, cashSymbol, isCashTransactionType, transactionInputSchema, withholdingFee, type Transaction, type TransactionInput } from '@portfolio/shared';
import type { ZodIssue } from 'zod';
import { useCreateTransaction } from '../../api/hooks';
import { usePortfolioSettings } from '../../api/management-hooks';
import { defaultTargetPortfolio, usePortfolioScope } from '../portfolios/usePortfolioScope';
import { errorMessage } from '../../api/client';
import { BASE_CURRENCY, normalizeDecimalInput } from '../../lib/format';
import { parseNumber } from '../management/form';

type FieldName = 'portfolioId' | 'date' | 'type' | 'symbol' | 'quantity' | 'price' | 'fee' | 'currency' | 'fxRate' | 'note';
type Values = Record<FieldName, string>;
type Errors = Partial<Record<FieldName, string>>;

const FIELD_ORDER: FieldName[] = ['portfolioId', 'date', 'type', 'symbol', 'currency', 'fxRate', 'quantity', 'price', 'fee', 'note'];
const COMMON_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'JPY', 'CAD', 'AUD'];

const today = () => new Date().toISOString().slice(0, 10);

const initialValues = (portfolioId: string): Values => ({
  portfolioId,
  date: today(),
  type: 'BUY',
  symbol: '',
  quantity: '',
  price: '',
  fee: '0',
  currency: BASE_CURRENCY,
  fxRate: '',
  note: '',
});

const normalizedCurrency = (raw: string) => raw.trim().toUpperCase();

/** The FX rate only applies to trades in a valid 3-letter currency other than the base (EUR). */
export const needsFxRate = (currency: string) => {
  const c = normalizedCurrency(currency);
  return /^[A-Z]{3}$/.test(c) && c !== BASE_CURRENCY;
};

const REQUIRED_MESSAGES: Partial<Record<FieldName, string>> = {
  date: 'Date is required',
  symbol: 'Symbol is required',
  quantity: 'Quantity is required',
  price: 'Price is required',
};

const NUMBER_RANGE_MESSAGES: Partial<Record<FieldName, string>> = {
  quantity: 'Quantity must be greater than 0',
  price: 'Price cannot be negative',
  fee: 'Fee cannot be negative',
  fxRate: 'FX rate must be greater than 0',
};

const STATIC_MESSAGES: Partial<Record<FieldName, string>> = {
  portfolioId: 'Choose a portfolio',
  date: 'Enter a date as YYYY-MM-DD',
  currency: 'Use a 3-letter currency code (e.g. EUR)',
  note: 'Note is too long (max 500 characters)',
};

function friendlyMessage(field: FieldName, issue: ZodIssue, raw: string): string {
  const required = REQUIRED_MESSAGES[field];
  if (required && raw.trim() === '') return required;
  const range = NUMBER_RANGE_MESSAGES[field];
  if (range) return issue.code === 'invalid_type' ? 'Enter a valid number' : range;
  if (field === 'symbol') {
    return issue.code === 'too_big' ? 'Symbol is too long (max 20 characters)' : 'Use letters, digits and . - : ^ = only (e.g. AAPL, VWRL.AS)';
  }
  return STATIC_MESSAGES[field] ?? issue.message;
}

const decimalOrUndefined = (raw: string) => (raw.trim() === '' ? undefined : normalizeDecimalInput(raw));

/** Cash movements have no symbol/price/fee of their own and a split has no price/fee: the form fixes those fields. */
function fixedFields(type: string, currency: string): Partial<Values> {
  if (isCashTransactionType(type)) return { symbol: cashSymbol(normalizedCurrency(currency)), price: '1', fee: '0' };
  if (type === 'SPLIT') return { price: '0', fee: '0' };
  return {};
}

/**
 * Validates raw form strings with the shared schema; empty numeric fields are reported as required.
 * Decimals may use a comma (Dutch input). The FX rate is optional and dropped for base-currency trades.
 */
export function validateTransaction(values: Omit<Values, 'fxRate'> & { fxRate?: string }): { data?: TransactionInput; errors: Errors } {
  const { fxRate = '', ...rest } = { ...values, ...fixedFields(values.type, values.currency) };
  const rate = needsFxRate(values.currency) ? decimalOrUndefined(fxRate) : undefined;
  const candidate = {
    ...rest,
    quantity: decimalOrUndefined(rest.quantity),
    price: decimalOrUndefined(rest.price),
    fee: normalizeDecimalInput(rest.fee),
    note: values.note.trim() === '' ? undefined : values.note.trim(),
    ...(rate !== undefined ? { fxRate: rate } : {}),
  };
  const res = transactionInputSchema.safeParse(candidate);
  if (res.success) return { data: res.data, errors: {} };
  const errors: Errors = {};
  for (const issue of res.error.issues) {
    // The symbol of a cash movement is derived from its currency, so that is where the user can fix it.
    const raw = issue.path[0] as FieldName | undefined;
    const field = raw === 'symbol' && isCashTransactionType(values.type) ? 'currency' : raw;
    if (field && !errors[field]) errors[field] = friendlyMessage(field, issue, values[field] ?? '');
  }
  return { errors };
}

const TYPE_LABELS: Record<(typeof TRANSACTION_TYPES)[number], string> = {
  BUY: 'Buy',
  SELL: 'Sell',
  DIVIDEND: 'Dividend',
  DEPOSIT: 'Cash deposit',
  WITHDRAWAL: 'Cash withdrawal',
  SPLIT: 'Stock split',
  FEE: 'Account fee',
  INTEREST: 'Interest',
};

const QUANTITY_LABELS: Partial<Record<string, string>> = {
  DIVIDEND: 'Eligible units',
  SPLIT: 'New shares per old share',
  DEPOSIT: 'Amount',
  WITHDRAWAL: 'Amount',
  FEE: 'Amount',
  INTEREST: 'Amount',
};

/** The fee field: the portfolio's default withholding rate applied to the gross dividend until the user edits it. */
function dividendFee(values: Values, ratePct: number | undefined, auto: boolean): string {
  if (!auto || ratePct === undefined) return values.fee;
  const quantity = parseNumber(values.quantity);
  const price = parseNumber(values.price);
  return quantity === undefined || price === undefined ? values.fee : String(withholdingFee(quantity, price, ratePct));
}

interface Props {
  onSuccess?: (txn: Transaction) => void;
  onCancel?: () => void;
}

export function TransactionForm({ onSuccess, onCancel }: Readonly<Props>) {
  const { scope, portfolios } = usePortfolioScope();
  const [values, setValues] = useState<Values>(() => initialValues(defaultTargetPortfolio(scope, portfolios)));
  // The list may load after the form opens, or the preselected portfolio may not exist (any more).
  const portfolioId =
    portfolios && !portfolios.some((p) => p.portfolioId === values.portfolioId) ? defaultTargetPortfolio(scope, portfolios) : values.portfolioId;
  const [errors, setErrors] = useState<Errors>({});
  const [feeEdited, setFeeEdited] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const mutation = useCreateTransaction();
  const withholdingRate = usePortfolioSettings(portfolioId).data?.withholdingTaxRate;
  const isDividend = values.type === 'DIVIDEND';
  const fee = dividendFee(values, withholdingRate, isDividend && !feeEdited);

  const set = (field: FieldName) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const v = e.target.value;
    if (field === 'fee') setFeeEdited(true);
    setValues((s) => ({ ...s, [field]: v }));
    if (errors[field]) setErrors((s) => ({ ...s, [field]: undefined }));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const { data, errors: errs } = validateTransaction({ ...values, fee, portfolioId });
    setErrors(errs);
    if (!data) {
      const first = FIELD_ORDER.find((f) => errs[f]);
      if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    mutation.mutate(data, {
      onSuccess: (txn) => {
        setValues(initialValues(txn.portfolioId));
        setFeeEdited(false);
        onSuccess?.(txn);
      },
    });
  };

  const fieldValue = (name: FieldName) => {
    if (name === 'portfolioId') return portfolioId;
    return name === 'fee' ? fee : values[name];
  };

  const fieldProps = (name: FieldName, helpId?: string) => {
    const describedBy = [helpId, errors[name] ? `txn-${name}-error` : undefined].filter(Boolean).join(' ');
    return {
      id: `txn-${name}`,
      name,
      value: fieldValue(name),
      onChange: set(name),
      'aria-invalid': errors[name] ? true : undefined,
      'aria-describedby': describedBy || undefined,
    };
  };

  const fieldError = (name: FieldName) =>
    errors[name] ? (
      <p id={`txn-${name}-error`} className="mt-1 text-xs text-red-600 dark:text-red-400">
        {errors[name]}
      </p>
    ) : null;

  const isCash = isCashTransactionType(values.type);
  const isSplit = values.type === 'SPLIT';
  const showFxRate = needsFxRate(values.currency);

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate aria-label="Add transaction" className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="txn-portfolioId">Portfolio</label>
          <select className="input" required {...fieldProps('portfolioId')}>
            {portfolios ? (
              portfolios.map((p) => (
                <option key={p.portfolioId} value={p.portfolioId}>
                  {p.name}
                </option>
              ))
            ) : (
              <option value={portfolioId}>Loading portfolios…</option>
            )}
          </select>
          {fieldError('portfolioId')}
        </div>
        <div>
          <label className="label" htmlFor="txn-date">Date</label>
          <input type="date" className="input" max={today()} required {...fieldProps('date')} data-autofocus />
          {fieldError('date')}
        </div>
        <div>
          <label className="label" htmlFor="txn-type">Type</label>
          <select className="input" {...fieldProps('type')}>
            {TRANSACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          {fieldError('type')}
        </div>
        {!isCash && (
          <div>
            <label className="label" htmlFor="txn-symbol">Symbol</label>
            <input type="text" className="input uppercase" placeholder="e.g. VWRL.AS" autoComplete="off" spellCheck={false} required {...fieldProps('symbol')} />
            {fieldError('symbol')}
          </div>
        )}
        <div>
          <label className="label" htmlFor="txn-currency">Currency</label>
          <input type="text" className="input uppercase" list="txn-currency-options" maxLength={3} required {...fieldProps('currency')} />
          <datalist id="txn-currency-options">
            {COMMON_CURRENCIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          {fieldError('currency')}
        </div>
        {showFxRate && (
          <div className="sm:col-span-2">
            <label className="label" htmlFor="txn-fxRate">
              FX rate ({normalizedCurrency(values.currency)} per 1 {BASE_CURRENCY}) <span className="muted font-normal">(optional)</span>
            </label>
            <input type="text" inputMode="decimal" className="input" placeholder="e.g. 1,0842" autoComplete="off" {...fieldProps('fxRate', 'txn-fxRate-help')} />
            <p id="txn-fxRate-help" className="muted mt-1 text-xs">
              From your broker statement. Leave empty to use the ECB rate of the trade date.
            </p>
            {fieldError('fxRate')}
          </div>
        )}
        <div>
          <label className="label" htmlFor="txn-quantity">{QUANTITY_LABELS[values.type] ?? 'Quantity'}</label>
          <input type="text" inputMode="decimal" className="input" required {...fieldProps('quantity', isSplit ? 'txn-quantity-help' : undefined)} />
          {isSplit && <p id="txn-quantity-help" className="muted mt-1 text-xs">4 for a 4-for-1 split, 0,1 for a 1-for-10 reverse split. Total cost stays the same.</p>}
          {fieldError('quantity')}
        </div>
        {!isCash && !isSplit && (
          <>
            <div>
              <label className="label" htmlFor="txn-price">{isDividend ? 'Gross dividend per unit' : 'Price per unit'}</label>
              <input type="text" inputMode="decimal" className="input" required {...fieldProps('price')} />
              {fieldError('price')}
            </div>
            <div>
              <label className="label" htmlFor="txn-fee">{isDividend ? 'Withholding tax' : 'Fee'}</label>
              <input type="text" inputMode="decimal" className="input" {...fieldProps('fee', isDividend && withholdingRate !== undefined ? 'txn-fee-help' : undefined)} />
              {isDividend && withholdingRate !== undefined && (
                <p id="txn-fee-help" className="muted mt-1 text-xs">Calculated at the portfolio&apos;s default {withholdingRate}% of the gross dividend; edit to override.</p>
              )}
              {fieldError('fee')}
            </div>
          </>
        )}
        {isCash && (
          <p className="muted text-xs sm:col-span-2">Cash movements only count when cash tracking is switched on for the portfolio (Transactions → Settings).</p>
        )}
        <div className="sm:col-span-2">
          <label className="label" htmlFor="txn-note">
            Note <span className="muted font-normal">(optional)</span>
          </label>
          <textarea className="input" rows={2} maxLength={500} {...fieldProps('note')} />
          {fieldError('note')}
        </div>
      </div>

      {mutation.isError && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
          {errorMessage(mutation.error)}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save transaction'}
        </button>
      </div>
    </form>
  );
}
