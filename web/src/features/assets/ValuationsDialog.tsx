import { useState, type FormEvent } from 'react';
import type { CustomAssetWithValue } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useAssetMutations, useAssets } from '../../api/management-hooks';
import { Dialog } from '../../components/Dialog';
import { formatDate, formatMoney } from '../../lib/format';
import { parseNumber } from '../management/form';

const today = () => new Date().toISOString().slice(0, 10);

interface Props {
  portfolioId: string;
  asset: CustomAssetWithValue;
  onClose: () => void;
}

/** Valuation points of a custom asset: add (or replace the one on the same date) and delete. */
export function ValuationsDialog({ portfolioId, asset, onClose }: Readonly<Props>) {
  const { putValuation, deleteValuation } = useAssetMutations(portfolioId);
  const [date, setDate] = useState(today());
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The asset in the props is a snapshot from when the dialog opened; the list query holds the current points.
  const current = useAssets(portfolioId).data?.assets.find((a) => a.assetId === asset.assetId) ?? asset;
  const busy = putValuation.isPending || deleteValuation.isPending;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const v = parseNumber(value);
    if (v === undefined || v < 0) return setError('Enter the value on that date');
    setError(null);
    try {
      await putValuation.mutateAsync({ id: asset.assetId, body: { date, value: v } });
      setValue('');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const remove = async (pointDate: string) => {
    setError(null);
    try {
      await deleteValuation.mutateAsync({ id: asset.assetId, date: pointDate });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Valuations · ${asset.name}`} size="md">
      <ul className="mb-4 divide-y divide-slate-100 text-sm dark:divide-slate-800" aria-label="Valuation points">
        {[...current.valuations].reverse().map((v) => (
          <li key={v.date} className="flex items-center justify-between gap-3 py-2">
            <span>{formatDate(v.date)}</span>
            <span className="ml-auto font-medium tabular-nums">{formatMoney(v.value, asset.currency)}</span>
            <button type="button" className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40" aria-label={`Delete valuation of ${formatDate(v.date)}`} disabled={busy || current.valuations.length === 1} onClick={() => void remove(v.date)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void add(e)} noValidate aria-label="Add valuation" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="val-date">Date</label>
          <input id="val-date" type="date" className="input" max={today()} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="val-value">Value ({asset.currency})</label>
          <input id="val-value" className="input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} data-autofocus />
        </div>
        <div className="flex items-end">
          <button type="submit" className="btn-primary w-full" disabled={busy}>Save valuation</button>
        </div>
      </form>
      {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
    </Dialog>
  );
}
