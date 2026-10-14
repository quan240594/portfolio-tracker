import { useState, type FormEvent } from 'react';
import { ASSET_CLASSES, type AssetClass, type CustomAssetWithValue } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useAssetMutations } from '../../api/management-hooks';
import { Dialog } from '../../components/Dialog';
import { BASE_CURRENCY } from '../../lib/format';
import { numberToInput, parseNumber } from '../management/form';

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  STOCK: 'Stock',
  ETF: 'ETF',
  CRYPTO: 'Crypto',
  BOND: 'Bond / loan',
  CASH: 'Cash',
  REAL_ESTATE: 'Real estate',
  DEPOSIT: 'Savings / deposit',
  OTHER: 'Other (e.g. private equity)',
};
const SELECTABLE_CLASSES = ASSET_CLASSES.filter((c) => c !== 'CASH');
const today = () => new Date().toISOString().slice(0, 10);

interface Props {
  portfolioId: string;
  /** Asset being edited; `null` creates a new one. */
  asset: CustomAssetWithValue | null;
  onClose: () => void;
}

/** Create or edit a custom asset (real estate, savings, P2P loan, private equity, ...). */
export function AssetDialog({ portfolioId, asset, onClose }: Readonly<Props>) {
  const { create, update } = useAssetMutations(portfolioId);
  const [name, setName] = useState(asset?.name ?? '');
  const [assetClass, setAssetClass] = useState<AssetClass>(asset?.assetClass ?? 'REAL_ESTATE');
  const [currency, setCurrency] = useState(asset?.currency ?? BASE_CURRENCY);
  const [value, setValue] = useState('');
  const [date, setDate] = useState(today());
  const [costBasis, setCostBasis] = useState(numberToInput(asset?.costBasis));
  const [growth, setGrowth] = useState(numberToInput(asset?.growthRate));
  const [error, setError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const growthRate = growth.trim() === '' ? null : parseNumber(growth);
    const cost = parseNumber(costBasis);
    if (name.trim() === '') return setError('Name is required');
    if (growthRate === undefined) return setError('Growth must be a number');
    if (costBasis.trim() !== '' && (cost === undefined || cost < 0)) return setError('Cost basis must be 0 or more');
    try {
      if (asset) {
        await update.mutateAsync({ id: asset.assetId, body: { name: name.trim(), assetClass, growthRate, ...(cost === undefined ? {} : { costBasis: cost }) } });
      } else {
        const initial = parseNumber(value);
        if (initial === undefined || initial < 0) return setError('Enter the current value');
        if (!/^[A-Za-z]{3}$/.test(currency.trim())) return setError('Use a 3-letter currency code (e.g. EUR)');
        await create.mutateAsync({
          name: name.trim(),
          assetClass,
          currency: currency.trim().toUpperCase(),
          value: initial,
          date,
          growthRate,
          ...(cost === undefined ? {} : { costBasis: cost }),
        });
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open onClose={onClose} title={asset ? `Edit ${asset.name}` : 'Add custom asset'} size="lg">
      <form onSubmit={(e) => void onSubmit(e)} noValidate aria-label="Custom asset" className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="asset-name">Name</label>
            <input id="asset-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-autofocus />
          </div>
          <div>
            <label className="label" htmlFor="asset-class">Type</label>
            <select id="asset-class" className="input" value={assetClass} onChange={(e) => setAssetClass(e.target.value as AssetClass)}>
              {SELECTABLE_CLASSES.map((c) => <option key={c} value={c}>{ASSET_CLASS_LABELS[c]}</option>)}
            </select>
          </div>
          {!asset && (
            <>
              <div>
                <label className="label" htmlFor="asset-currency">Currency</label>
                <input id="asset-currency" className="input uppercase" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="asset-value">Current value</label>
                <input id="asset-value" className="input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="asset-date">Valuation date</label>
                <input id="asset-date" type="date" className="input" max={today()} value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            </>
          )}
          <div>
            <label className="label" htmlFor="asset-cost">Amount invested <span className="muted font-normal">(optional)</span></label>
            <input id="asset-cost" className="input" inputMode="decimal" value={costBasis} onChange={(e) => setCostBasis(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="asset-growth">Annual growth % <span className="muted font-normal">(optional)</span></label>
            <input id="asset-growth" className="input" inputMode="decimal" value={growth} onChange={(e) => setGrowth(e.target.value)} />
          </div>
        </div>
        <p className="muted text-xs">
          The value follows your valuation points and grows by the annual rate after the latest one. Amounts are in the asset&apos;s own currency and converted to EUR.
        </p>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Saving…' : 'Save asset'}</button>
        </div>
      </form>
    </Dialog>
  );
}
