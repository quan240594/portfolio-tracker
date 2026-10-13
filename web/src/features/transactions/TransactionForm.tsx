import { useRef, useState, type FormEvent } from 'react';
import { TRANSACTION_TYPES, transactionInputSchema, type Transaction, type TransactionInput } from '@portfolio/shared';
import type { ZodIssue } from 'zod';
import { useCreateTransaction } from '../../api/hooks';
import { errorMessage } from '../../api/client';
import { BASE_CURRENCY, normalizeDecimalInput } from '../../lib/format';

type FieldName = 'date' | 'type' | 'symbol' | 'quantity' | 'price' | 'fee' | 'currency' | 'fxRate' | 'note';
type Values = Record<FieldName, string>;
type Errors = Partial<Record<FieldName, string>>;

const FIELD_ORDER: FieldName[] = ['date', 'type', 'symbol', 'currency', 'fxRate', 'quantity', 'price', 'fee', 'note'];
const COMMON_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'JPY', 'CAD', 'AUD'];

const today = () => new Date().toISOString().slice(0, 10);

const initialValues = (): Values => ({
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

function friendlyMessage(field: FieldName, issue: ZodIssue, raw: string): string {
  const empty = raw.trim() === '';
  switch (field) {
    case 'date':
      return empty ? 'Date is required' : 'Enter a date as YYYY-MM-DD';
    case 'symbol':
      if (empty) return 'Symbol is required';
      return issue.code === 'too_big' ? 'Symbol is too long (max 20 characters)' : 'Use letters, digits and . - : ^ = only (e.g. AAPL, VWRL.AS)';
    case 'quantity':
      if (empty) return 'Quantity is required';
      return issue.code === 'invalid_type' ? 'Enter a valid number' : 'Quantity must be greater than 0';
    case 'price':
      if (empty) return 'Price is required';
      return issue.code === 'invalid_type' ? 'Enter a valid number' : 'Price cannot be negative';
    case 'fee':
      return issue.code === 'invalid_type' ? 'Enter a valid number' : 'Fee cannot be negative';
    case 'currency':
      return 'Use a 3-letter currency code (e.g. EUR)';
    case 'fxRate':
      return issue.code === 'invalid_type' ? 'Enter a valid number' : 'FX rate must be greater than 0';
    case 'note':
      return 'Note is too long (max 500 characters)';
    default:
      return issue.message;
  }
}

const decimalOrUndefined = (raw: string) => (raw.trim() === '' ? undefined : normalizeDecimalInput(raw));

/**
 * Validates raw form strings with the shared schema; empty numeric fields are reported as required.
 * Decimals may use a comma (Dutch input). The FX rate is optional and dropped for base-currency trades.
 */
export function validateTransaction(values: Omit<Values, 'fxRate'> & { fxRate?: string }): { data?: TransactionInput; errors: Errors } {
  const { fxRate = '', ...rest } = values;
  const rate = needsFxRate(values.currency) ? decimalOrUndefined(fxRate) : undefined;
  const candidate = {
    ...rest,
    quantity: decimalOrUndefined(values.quantity),
    price: decimalOrUndefined(values.price),
    fee: normalizeDecimalInput(values.fee),
    note: values.note.trim() === '' ? undefined : values.note.trim(),
    ...(rate !== undefined ? { fxRate: rate } : {}),
  };
  const res = transactionInputSchema.safeParse(candidate);
  if (res.success) return { data: res.data, errors: {} };
  const errors: Errors = {};
  for (const issue of res.error.issues) {
    const field = issue.path[0] as FieldName | undefined;
    if (field && !errors[field]) errors[field] = friendlyMessage(field, issue, values[field] ?? '');
  }
  return { errors };
}

interface Props {
  onSuccess?: (txn: Transaction) => void;
  onCancel?: () => void;
}

export function TransactionForm({ onSuccess, onCancel }: Props) {
  const [values, setValues] = useState<Values>(initialValues);
  const [errors, setErrors] = useState<Errors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const mutation = useCreateTransaction();

  const set = (field: FieldName) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const v = e.target.value;
    setValues((s) => ({ ...s, [field]: v }));
    if (errors[field]) setErrors((s) => ({ ...s, [field]: undefined }));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const { data, errors: errs } = validateTransaction(values);
    setErrors(errs);
    if (!data) {
      const first = FIELD_ORDER.find((f) => errs[f]);
      if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    mutation.mutate(data, {
      onSuccess: (txn) => {
        setValues(initialValues());
        onSuccess?.(txn);
      },
    });
  };

  const fieldProps = (name: FieldName, helpId?: string) => {
    const describedBy = [helpId, errors[name] ? `txn-${name}-error` : undefined].filter(Boolean).join(' ');
    return {
      id: `txn-${name}`,
      name,
      value: values[name],
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

  const isDividend = values.type === 'DIVIDEND';
  const showFxRate = needsFxRate(values.currency);

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate aria-label="Add transaction" className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                {t.charAt(0) + t.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
          {fieldError('type')}
        </div>
        <div>
          <label className="label" htmlFor="txn-symbol">Symbol</label>
          <input type="text" className="input uppercase" placeholder="e.g. VWRL.AS" autoComplete="off" spellCheck={false} required {...fieldProps('symbol')} />
          {fieldError('symbol')}
        </div>
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
          <label className="label" htmlFor="txn-quantity">{isDividend ? 'Eligible units' : 'Quantity'}</label>
          <input type="text" inputMode="decimal" className="input" required {...fieldProps('quantity')} />
          {fieldError('quantity')}
        </div>
        <div>
          <label className="label" htmlFor="txn-price">{isDividend ? 'Gross dividend per unit' : 'Price per unit'}</label>
          <input type="text" inputMode="decimal" className="input" required {...fieldProps('price')} />
          {fieldError('price')}
        </div>
        <div>
          <label className="label" htmlFor="txn-fee">{isDividend ? 'Withholding tax' : 'Fee'}</label>
          <input type="text" inputMode="decimal" className="input" {...fieldProps('fee')} />
          {fieldError('fee')}
        </div>
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
