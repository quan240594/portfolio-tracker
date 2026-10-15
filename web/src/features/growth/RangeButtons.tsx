import { GROWTH_RANGES, type GrowthRange } from '@portfolio/shared';
import { RANGE_LABELS } from './growthFormat';

/** Range selector: plain toggle buttons (`aria-pressed`), each reachable with Tab. */
export function RangeButtons({ label, value, onChange }: Readonly<{ label: string; value: GrowthRange; onChange: (range: GrowthRange) => void }>) {
  return (
    <fieldset className="inline-flex min-w-0 flex-wrap gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
      <legend className="sr-only">{label}</legend>
      {GROWTH_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={r === value}
          onClick={() => onChange(r)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            r === value
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
          }`}
        >
          {RANGE_LABELS[r]}
        </button>
      ))}
    </fieldset>
  );
}

/** "Compare" switch shared by the cards that overlay the benchmarks. */
export function CompareToggle({ checked, onChange, disabled }: Readonly<{ checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }>) {
  return (
    <label className="inline-flex items-center gap-2 text-xs font-medium">
      <input type="checkbox" className="h-4 w-4 rounded border-slate-300 accent-brand-600" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>Compare</span>
    </label>
  );
}
