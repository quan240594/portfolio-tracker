import { useId } from 'react';
import { CALENDAR_EVENT_TYPES, CALENDAR_SCOPES, CALENDAR_STATUSES, calendarMonthOf, type CalendarEventType, type CalendarScope, type CalendarStatus } from '@portfolio/shared';
import { formatMonthYear } from '../../lib/format';
import { EVENT_META, SCOPE_LABELS, STATUS_LABELS, shiftMonth, type CalendarRange, type CalendarUiState, type CalendarView } from './calendarModel';
import { KEY_SWATCH, STATUS_CHIP } from './calendarColours';
import { EventMarker } from './EventMarker';

interface ToggleOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

/** Segmented control built from native radio buttons. */
export function ToggleGroup<T extends string>({ legend, options, value, onChange }: Readonly<{ legend: string; options: readonly ToggleOption<T>[]; value: T; onChange: (value: T) => void }>) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className="inline-flex gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
        {options.map((o) => (
          <label key={o.value} title={o.title} className="relative">
            <input type="radio" name={name} value={o.value} checked={o.value === value} disabled={o.disabled} onChange={() => onChange(o.value)} className="peer sr-only" />
            <span className="block cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 peer-checked:bg-white peer-checked:text-slate-900 peer-checked:shadow-sm peer-focus-visible:outline-2 peer-focus-visible:outline-brand-500 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 dark:text-slate-400 dark:peer-checked:bg-slate-950 dark:peer-checked:text-white">
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const toggled = <T,>(list: readonly T[], item: T, all: readonly T[]): T[] => all.filter((v) => (v === item ? !list.includes(v) : list.includes(v)));

function CheckPill({ checked, onChange, className, children }: Readonly<{ checked: boolean; onChange: () => void; className: string; children: React.ReactNode }>) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium focus-within:outline-2 focus-within:outline-brand-500 ${className} ${checked ? '' : 'opacity-60'}`}>
      <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
      {children}
    </label>
  );
}

export function TypeFilter({ value, onChange }: Readonly<{ value: readonly CalendarEventType[]; onChange: (next: CalendarEventType[]) => void }>) {
  return (
    <fieldset>
      <legend className="muted mb-1 text-xs font-medium">Event types</legend>
      <div className="flex flex-wrap gap-1.5">
        {CALENDAR_EVENT_TYPES.map((type) => {
          const checked = value.includes(type);
          const accent = checked ? 'border-slate-500 bg-slate-100 dark:bg-slate-800' : 'border-slate-300 dark:border-slate-700';
          return (
            <CheckPill key={type} checked={checked} onChange={() => onChange(toggled(value, type, CALENDAR_EVENT_TYPES))} className={accent}>
              <EventMarker type={type} className="h-3.5 w-3.5" />
              {EVENT_META[type].label}
            </CheckPill>
          );
        })}
      </div>
    </fieldset>
  );
}

export function StatusFilter({ value, onChange }: Readonly<{ value: readonly CalendarStatus[]; onChange: (next: CalendarStatus[]) => void }>) {
  return (
    <fieldset>
      <legend className="muted mb-1 text-xs font-medium">Status</legend>
      <div className="flex flex-wrap gap-1.5">
        {CALENDAR_STATUSES.map((status) => {
          const checked = value.includes(status);
          const dashed = status === 'ESTIMATED' ? 'border-dashed' : '';
          const base = checked ? STATUS_CHIP[status] : 'border-slate-300 dark:border-slate-700';
          return (
            <CheckPill key={status} checked={checked} onChange={() => onChange(toggled(value, status, CALENDAR_STATUSES))} className={`${base} ${dashed}`}>
              {STATUS_LABELS[status]}
            </CheckPill>
          );
        })}
      </div>
    </fieldset>
  );
}

const KEY_ITEMS: readonly { id: string; label: string; swatch: string; marker?: CalendarEventType }[] = [
  { id: 'ex-dividend', label: 'Ex-dividend: violet', swatch: KEY_SWATCH.exDividend, marker: 'EX_DIVIDEND' },
  { id: 'paid', label: 'Received: green', swatch: KEY_SWATCH.PAID },
  { id: 'confirmed', label: 'Confirmed: blue', swatch: KEY_SWATCH.CONFIRMED },
  { id: 'estimated', label: 'Estimated: yellow, dashed', swatch: KEY_SWATCH.ESTIMATED },
];

/** What the colours of the rows mean: the ex-dividend has its own hue, every other event shows its status. The words repeat what the swatches show. */
export function ColourKey() {
  const id = useId();
  return (
    <div className="basis-full text-xs">
      <p id={id} className="muted mb-1 font-medium">
        Colours: ex-dividend by type, everything else by status
      </p>
      <ul aria-labelledby={id} className="flex flex-wrap gap-x-4 gap-y-1">
        {KEY_ITEMS.map((item) => (
          <li key={item.id} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`inline-flex h-5 min-w-5 items-center justify-center rounded border-l-4 ${item.swatch}`}>
              {item.marker && <EventMarker type={item.marker} className="h-3 w-3" />}
            </span>
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ScopeSelect({ value, onChange }: Readonly<{ value: CalendarScope; onChange: (next: CalendarScope) => void }>) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="muted mb-1 block text-xs font-medium">
        Show
      </label>
      <select id={id} className="input w-auto py-1.5 text-xs" value={value} onChange={(e) => onChange(e.target.value as CalendarScope)}>
        {CALENDAR_SCOPES.map((scope) => (
          <option key={scope} value={scope}>
            {SCOPE_LABELS[scope]}
          </option>
        ))}
      </select>
    </div>
  );
}

function Chevron({ direction }: Readonly<{ direction: 'left' | 'right' }>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={direction === 'left' ? 'm12 5-5 5 5 5' : 'm8 5 5 5-5 5'} />
    </svg>
  );
}

interface NavigatorProps {
  month: string;
  today: string;
  range: CalendarRange;
  onMonth: (month: string) => void;
}

/** Previous / next month and "today"; with the 12-month range the month is fixed. */
export function MonthNavigator({ month, today, range, onMonth }: Readonly<NavigatorProps>) {
  const year = range === 'year';
  const label = year ? 'Next 12 months' : formatMonthYear(month);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <button type="button" className="btn-secondary px-2.5" aria-label="Previous month" disabled={year} onClick={() => onMonth(shiftMonth(month, -1))}>
          <Chevron direction="left" />
        </button>
        <button type="button" className="btn-secondary px-2.5" aria-label="Next month" disabled={year} onClick={() => onMonth(shiftMonth(month, 1))}>
          <Chevron direction="right" />
        </button>
        <button type="button" className="btn-secondary" disabled={year || month === calendarMonthOf(today)} onClick={() => onMonth(calendarMonthOf(today))}>
          Today
        </button>
      </div>
      <h2 className="text-lg font-semibold capitalize" aria-live="polite">
        {label}
      </h2>
    </div>
  );
}

const RANGE_OPTIONS: readonly ToggleOption<CalendarRange>[] = [
  { value: 'month', label: 'This month' },
  { value: 'year', label: 'Next 12 months' },
];

interface ToolbarProps {
  state: CalendarUiState;
  today: string;
  onChange: (patch: Partial<CalendarUiState>) => void;
}

/** Month navigation, range and view toggles. */
export function ViewToolbar({ state, today, onChange }: Readonly<ToolbarProps>) {
  const viewOptions: readonly ToggleOption<CalendarView>[] = [
    { value: 'calendar', label: 'Calendar', disabled: state.range === 'year', title: state.range === 'year' ? 'The calendar grid shows one month at a time' : undefined },
    { value: 'list', label: 'List' },
  ];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <MonthNavigator month={state.month} today={today} range={state.range} onMonth={(month) => onChange({ month })} />
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup legend="Range" options={RANGE_OPTIONS} value={state.range} onChange={(range) => onChange(range === 'year' ? { range, view: 'list' } : { range })} />
        <ToggleGroup legend="View" options={viewOptions} value={state.view} onChange={(view) => onChange({ view })} />
      </div>
    </div>
  );
}

interface FiltersProps {
  state: CalendarUiState;
  onChange: (patch: Partial<CalendarUiState>) => void;
  onDownload: () => void;
  downloading: boolean;
  downloadDisabled: boolean;
}

export function FilterBar({ state, onChange, onDownload, downloading, downloadDisabled }: Readonly<FiltersProps>) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <TypeFilter value={state.types} onChange={(types) => onChange({ types })} />
      <StatusFilter value={state.statuses} onChange={(statuses) => onChange({ statuses })} />
      <ScopeSelect value={state.scope} onChange={(scope) => onChange({ scope })} />
      <button type="button" className="btn-secondary ml-auto" onClick={onDownload} disabled={downloading || downloadDisabled}>
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5M4 15.5h12" />
        </svg>
        {downloading ? 'Preparing…' : 'Download .ics'}
      </button>
      <ColourKey />
    </div>
  );
}
