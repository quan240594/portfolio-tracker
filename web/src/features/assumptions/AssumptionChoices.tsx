import type { ReactNode } from 'react';
import {
  INFLATION_AREAS,
  INFLATION_AREA_LABELS,
  INFLATION_HORIZONS,
  INFLATION_HORIZON_LABELS,
  YIELD_PRESETS,
  YIELD_PRESET_LABELS,
  type InflationArea,
  type InflationHorizon,
  type YieldPreset,
} from '@portfolio/shared';
import { InfoTip } from '../../components/InfoTip';
import { formatMonthYear, formatPercent } from '../../lib/format';
import {
  cachedFromText,
  clampText,
  ecbTargetText,
  growthBasisText,
  growthUnavailableText,
  inflationBasisText,
  inflationUnavailableText,
  yieldBasisText,
} from './assumptionText';
import type { GrowthHelper, InflationHelper, Source, YieldHelper } from './useGoalAssumptions';

const TIP_PANEL = 'absolute right-0 top-7 z-20 w-[min(18rem,calc(100vw-3rem))]';

interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** The figure the choice gives, shown under its name. */
  detail?: string;
  disabled?: boolean;
}

interface ChoicesProps<T extends string> {
  name: string;
  legend: string;
  tip: ReactNode;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
}

/** Radio choices shown side by side, each tile with its figure; a native fieldset + radios (keyboard: arrow keys) and an "i" explaining the helper. */
function Choices<T extends string>({ name, legend, tip, value, options, onChange }: Readonly<ChoicesProps<T>>) {
  return (
    <fieldset className="relative">
      <legend className="label">{legend}</legend>
      <div className="absolute -top-6 right-0">
        <InfoTip label={legend} panelClassName={TIP_PANEL}>
          {tip}
        </InfoTip>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-1.5">
        {options.map((option) => (
          <label key={option.value} className={option.disabled ? 'opacity-50' : undefined}>
            <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={option.disabled} onChange={() => onChange(option.value)} className="peer sr-only" />
            <span className="block h-full cursor-pointer rounded-md border border-slate-200 px-2 py-1.5 text-xs transition-colors peer-checked:border-brand-500 peer-checked:bg-brand-50 peer-focus-visible:outline-2 peer-focus-visible:outline-brand-500 peer-disabled:cursor-not-allowed dark:border-slate-700 dark:peer-checked:bg-slate-800">
              <span className="block font-medium">{option.label}</span>
              {option.detail && <span className="muted block">{option.detail}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const Note = ({ id, children }: Readonly<{ id: string; children: ReactNode }>) => (
  <output id={id} className="muted mt-1.5 block text-xs">
    {children}
  </output>
);

/** What a source that is not ready says; null when it is ready. */
function waiting<T>(source: Source<T>, what: string): string | null {
  if (source.status === 'loading') return `Calculating ${what}…`;
  if (source.status === 'error') return `Could not calculate ${what}: ${source.message}. Enter a value yourself.`;
  return null;
}

const pct = (value: number, digits: number): string => formatPercent(value, { digits });

// --- Dividend growth -----------------------------------------------------------------------------------------------------

export function GrowthChoices({ helper }: Readonly<{ helper: GrowthHelper }>) {
  const { source } = helper;
  const ready = source.status === 'ready' ? source.value : null;
  const figure = ready?.available ? pct(ready.pct, 1) : undefined;
  let note = waiting(source, 'dividend growth');
  if (ready?.available) note = `${growthBasisText(ready.basis)}. ${clampText(ready.rawPct, ready.pct, ready.clamped, 1)}`.trim();
  else if (ready) note = growthUnavailableText(ready);
  return (
    <div>
      <Choices
        name="assumption-growth"
        legend="Dividend growth source"
        value={helper.mode}
        onChange={helper.setMode}
        options={[
          { value: 'manual', label: 'Manual' },
          { value: 'portfolio', label: 'From my portfolio', detail: figure, disabled: ready !== null && !ready.available },
        ]}
        tip={
          <>
            <p>The compound annual growth rate of the dividend paid per share, over the full years each holding has paid: first year against last year, so buying more shares does not count as growth.</p>
            <p>The holdings are weighted by the income they are expected to pay over the next 12 months. A holding’s rate is limited to the range of the field so one special dividend cannot dominate.</p>
            <p>Past growth does not promise future growth. Typing in the field switches back to Manual.</p>
          </>
        }
      />
      {note && <Note id="assumption-growth-note">{note}</Note>}
    </div>
  );
}

// --- Yield on new money --------------------------------------------------------------------------------------------------

export function YieldChoices({ helper }: Readonly<{ helper: YieldHelper }>) {
  const { source } = helper;
  const data = source.status === 'ready' ? source.value : null;
  const detailOf = (preset: YieldPreset): string | undefined => {
    const suggestion = data?.candidates[preset];
    return suggestion?.available ? pct(suggestion.pct, 2) : undefined;
  };
  const options: ChoiceOption<YieldPreset | 'manual'>[] = [
    { value: 'manual', label: 'Manual' },
    ...YIELD_PRESETS.map((preset) => ({ value: preset, label: YIELD_PRESET_LABELS[preset], detail: detailOf(preset), disabled: data !== null && !data.candidates[preset].available })),
  ];
  const chosen = data && helper.mode !== 'manual' ? data.candidates[helper.mode] : null;
  let note = waiting(source, 'the yield');
  if (chosen?.available) note = `${YIELD_PRESET_LABELS[chosen.basis.preset]}: ${yieldBasisText(chosen.basis, data!.currency)}. ${clampText(chosen.rawPct, chosen.pct, chosen.clamped, 2)}`.trim();
  else if (data && !data.candidates.portfolio.available) note = 'No dividend income yet, so there is no yield to calculate. Enter a value yourself.';
  return (
    <div>
      <Choices
        name="assumption-yield"
        legend="Yield on new money from"
        value={helper.mode}
        onChange={helper.setMode}
        options={options}
        tip={
          <>
            <p>The dividend yield you expect on money you invest from now on. The three figures come from your portfolio’s expected dividends over the next 12 months:</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>Portfolio forward yield: that income divided by the value of all holdings (the Yield on the Dividends page).</li>
              <li>Dividend payers only: the same income divided by the value of only the holdings that pay dividends, so growth stocks and accumulating funds do not pull it down.</li>
              <li>Yield on cost: the income divided by what you paid.</li>
            </ul>
            <p>
              {data ? `Your portfolio yields ${pct(data.portfolioYieldPct, 2)} and ${data.payers} holdings pay dividends. ` : ''}
              Below 1% with at least 5 payers, “Dividend payers only” is the default.
            </p>
          </>
        }
      />
      {note && <Note id="assumption-yield-note">{note}</Note>}
    </div>
  );
}

// --- Inflation -----------------------------------------------------------------------------------------------------------

const INFLATION_MODES = [
  { value: 'manual', label: 'Manual' },
  { value: 'ecb', label: 'ECB history' },
  { value: 'target', label: 'ECB target', detail: '2,0%' },
] as const;

function SelectField<T extends string>({ id, label, value, values, labels, onChange }: Readonly<{ id: string; label: string; value: T; values: readonly T[]; labels: Record<T, string>; onChange: (value: T) => void }>) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {values.map((v) => (
          <option key={v} value={v}>
            {labels[v]}
          </option>
        ))}
      </select>
    </div>
  );
}

function InflationNote({ helper }: Readonly<{ helper: InflationHelper }>) {
  const { source } = helper;
  const waitingText = waiting(source, 'inflation');
  if (waitingText) return <Note id="assumption-inflation-note">{waitingText}</Note>;
  const data = source.status === 'ready' ? source.value : null;
  if (data?.kind === 'target') return <Note id="assumption-inflation-note">{ecbTargetText}</Note>;
  if (data?.kind !== 'ecb') return null;
  const { series, suggestion } = data;
  if (!suggestion.available) return <Note id="assumption-inflation-note">{inflationUnavailableText(suggestion)}</Note>;
  const origin = series.stale ? `ECB data, latest ${formatMonthYear(series.latestMonth)} (the ECB could not be reached, ${cachedFromText(series.fetchedAt)})` : `ECB data, latest ${formatMonthYear(series.latestMonth)}, ${cachedFromText(series.fetchedAt)}`;
  return (
    <Note id="assumption-inflation-note">
      {inflationBasisText(suggestion.basis)}. {clampText(suggestion.rawPct, suggestion.pct, suggestion.clamped, 1)} {origin}.
    </Note>
  );
}

export function InflationChoices({ helper }: Readonly<{ helper: InflationHelper }>) {
  const { source } = helper;
  const data = source.status === 'ready' ? source.value : null;
  const ecbFigure = data?.kind === 'ecb' && data.suggestion.available ? pct(data.suggestion.pct, 1) : undefined;
  return (
    <div className="space-y-2">
      <Choices
        name="assumption-inflation"
        legend="Inflation source"
        value={helper.mode}
        onChange={helper.setMode}
        options={INFLATION_MODES.map((mode) => ({ ...mode, detail: mode.value === 'ecb' ? ecbFigure : ('detail' in mode ? mode.detail : undefined) }))}
        tip={
          <>
            <p>ECB history: the average yearly price increase (HICP, the European consumer price index) over the period you choose, for the euro area or the Netherlands. It is the compound rate of the price level from that many years ago to the latest month. The server reads it from the ECB and stores it for a month.</p>
            <p>ECB target: 2%, the rate the ECB aims for in the medium term. A reference, not a measurement.</p>
            <p>Past inflation does not promise future inflation. Typing in the field switches back to Manual.</p>
          </>
        }
      />
      {helper.mode === 'ecb' && (
        <div className="grid grid-cols-2 gap-2">
          <SelectField id="assumption-inflation-area" label="Inflation area" value={helper.area} values={INFLATION_AREAS} labels={INFLATION_AREA_LABELS} onChange={(area: InflationArea) => helper.setArea(area)} />
          <SelectField id="assumption-inflation-period" label="Inflation period" value={helper.horizon} values={INFLATION_HORIZONS} labels={INFLATION_HORIZON_LABELS} onChange={(horizon: InflationHorizon) => helper.setHorizon(horizon)} />
        </div>
      )}
      <InflationNote helper={helper} />
    </div>
  );
}
