import { useState, type FormEvent } from 'react';
import { currencySchema, type CalendarEvent, type Holding } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useManualDividendMutations } from '../../api/calendarHooks';
import { Dialog } from '../../components/Dialog';
import { numberToInput, parseNumber } from '../management/form';

interface Props {
  /** The held symbols the entry may be for. */
  holdings: readonly Pick<Holding, 'symbol' | 'name' | 'currency'>[];
  /** The entry being edited (an event of source `manual`); null adds a new one. */
  event: CalendarEvent | null;
  onClose: () => void;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day fields must be dates, the pay date not before the ex-date, the amount positive when given. */
function validate(fields: { exDate: string; payDate: string; amount: number | undefined; amountText: string; currency: string }): string | null {
  if (!DAY.test(fields.exDate)) return 'Enter the ex-dividend date';
  if (fields.payDate !== '' && !DAY.test(fields.payDate)) return 'The payment date is not a valid date';
  if (fields.payDate !== '' && fields.payDate < fields.exDate) return 'The payment date cannot be before the ex-dividend date';
  if (fields.amountText.trim() !== '' && (fields.amount === undefined || fields.amount <= 0)) return 'The amount per share must be a positive number';
  if (fields.currency.trim() !== '' && !currencySchema.safeParse(fields.currency).success) return 'The currency is a 3-letter code such as USD';
  return null;
}

/**
 * "Add dividend date": for a payer whose dividend the data providers do not list yet. The entry is a declared event of yours (marked "entered by you");
 * a provider record for the same ex-date that has an amount replaces it, and it can be edited or removed here.
 */
export function ManualDividendDialog({ holdings, event, onClose }: Readonly<Props>) {
  const { add } = useManualDividendMutations();
  const editing = event !== null;
  const [symbol, setSymbol] = useState(event?.symbol ?? holdings[0]?.symbol ?? '');
  const [exDate, setExDate] = useState(event?.exDate ?? '');
  const [payDate, setPayDate] = useState(event?.payDate ?? '');
  const [amount, setAmount] = useState(numberToInput(event?.amountPerShare !== undefined && event.amountPerShare > 0 ? event.amountPerShare : undefined));
  const [currency, setCurrency] = useState(event?.currency ?? holdings[0]?.currency ?? '');
  const [error, setError] = useState<string | null>(null);

  const pick = (next: string) => {
    setSymbol(next);
    if (!editing) setCurrency(holdings.find((holding) => holding.symbol === next)?.currency ?? '');
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseNumber(amount);
    const problem = symbol === '' ? 'Choose a symbol' : validate({ exDate, payDate, amount: parsed, amountText: amount, currency });
    if (problem !== null) return setError(problem);
    setError(null);
    add.mutate(
      { symbol, exDate, ...(payDate === '' ? {} : { payDate }), ...(parsed === undefined ? {} : { amount: parsed }), ...(currency.trim() === '' ? {} : { currency }) },
      { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
    );
  };

  return (
    <Dialog open onClose={onClose} title={editing ? `Edit dividend date · ${symbol}` : 'Add dividend date'} description="For a dividend the data providers do not list yet. It shows as entered by you until a provider lists it with an amount.">
      <form onSubmit={onSubmit} noValidate aria-label="Dividend date" className="space-y-4">
        <div>
          <label className="label" htmlFor="md-symbol">
            Symbol
          </label>
          <select id="md-symbol" className="input" value={symbol} onChange={(e) => pick(e.target.value)} disabled={editing} data-autofocus>
            {holdings.map((holding) => (
              <option key={holding.symbol} value={holding.symbol}>
                {holding.symbol} · {holding.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="md-ex">
              Ex-dividend date
            </label>
            <input id="md-ex" type="date" className="input" value={exDate} onChange={(e) => setExDate(e.target.value)} disabled={editing} />
          </div>
          <div>
            <label className="label" htmlFor="md-pay">
              Payment date (optional)
            </label>
            <input id="md-pay" type="date" className="input" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="md-amount">
              Amount per share (optional)
            </label>
            <input id="md-amount" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="md-currency">
              Currency
            </label>
            <input id="md-currency" className="input" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </div>
        </div>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={add.isPending}>
            {add.isPending ? 'Saving…' : 'Save dividend date'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
