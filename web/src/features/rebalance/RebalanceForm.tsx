import { useState, type FormEvent } from 'react';
import { REBALANCE_MODES, type RebalanceMode, type RebalanceQuery } from '@portfolio/shared';
import { SegmentedControl } from '../../components/SegmentedControl';
import { parseNumber } from '../management/form';

const MODE_OPTIONS: { value: RebalanceMode; label: string }[] = [
  { value: 'buy-only', label: 'Buy only' },
  { value: 'full', label: 'Full rebalance' },
];
const MODE_HELP: Record<RebalanceMode, string> = {
  'buy-only': 'Invest new money in the categories that are furthest below target. Nothing is sold.',
  full: 'Sell what is above target and buy what is below. New money is optional.',
};

interface Props {
  disabled?: boolean;
  onSubmit: (query: RebalanceQuery) => void;
}

/** Mode, amount to invest, whole-unit rounding and minimum trade size. */
export function RebalanceForm({ disabled, onSubmit }: Readonly<Props>) {
  const [mode, setMode] = useState<RebalanceMode>(REBALANCE_MODES[0]);
  const [amount, setAmount] = useState('1000');
  const [minTrade, setMinTrade] = useState('0');
  const [wholeUnits, setWholeUnits] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const amountValue = parseNumber(amount) ?? 0;
    const minValue = parseNumber(minTrade) ?? 0;
    if (amountValue < 0 || minValue < 0) return setError('Amounts cannot be negative');
    if (mode === 'buy-only' && amountValue <= 0) return setError('Enter the amount you want to invest');
    setError(null);
    onSubmit({ mode, amount: amountValue, minTrade: minValue, wholeUnits });
  };

  return (
    <form onSubmit={submit} noValidate aria-label="Rebalance settings" className="card space-y-4 p-4">
      <h2 className="font-semibold">Plan trades</h2>
      <div>
        <SegmentedControl label="Rebalance mode" options={MODE_OPTIONS} value={mode} onChange={setMode} />
        <p className="muted mt-2 text-xs">{MODE_HELP[mode]}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="rb-amount">{mode === 'buy-only' ? 'Amount to invest (EUR)' : 'New money to add (EUR, optional)'}</label>
          <input id="rb-amount" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="rb-min">Minimum trade (EUR)</label>
          <input id="rb-min" className="input" inputMode="decimal" value={minTrade} onChange={(e) => setMinTrade(e.target.value)} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={wholeUnits} onChange={(e) => setWholeUnits(e.target.checked)} />
        <span>Whole units only (no fractional shares)</span>
      </label>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      <button type="submit" className="btn-primary" disabled={disabled}>Calculate trades</button>
    </form>
  );
}
