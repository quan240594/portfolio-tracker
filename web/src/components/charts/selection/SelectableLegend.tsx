import { useEffect, type CSSProperties, type FocusEvent, type PointerEvent, type ReactNode } from 'react';
import type { SelectionView } from './useSeriesSelection';
import { SelectionNote } from './SelectionNotes';

export interface LegendSwatchProps {
  /** `square` = bar / area / slice (default), `line` = line series, `dot` = marker series. */
  shape?: 'square' | 'line' | 'dot';
  color: string;
  /** Edge colour of a square (the darker outline of a pastel bar). */
  edge?: string;
  /** Dashed edge or dashed line: estimated and forecast series. */
  dashed?: boolean;
}

function swatchStyle({ shape = 'square', color, edge, dashed }: LegendSwatchProps): CSSProperties {
  const style = dashed ? 'dashed' : 'solid';
  if (shape === 'line') return { borderTopStyle: style, borderTopColor: color };
  return { background: color, border: edge ? `1px ${style} ${edge}` : undefined };
}

/** The colour key of a series: decorative (the label carries the meaning), so hidden from assistive technology. */
export function LegendSwatch(props: Readonly<LegendSwatchProps>) {
  const { shape = 'square' } = props;
  const size = shape === 'line' ? 'inline-block w-4 border-t-2' : 'inline-block h-2.5 w-2.5';
  const rounding = { square: 'rounded-sm', dot: 'rounded-full', line: '' }[shape];
  return <span aria-hidden="true" className={`${size} ${rounding}`} style={swatchStyle(props)} />;
}

export interface LegendEntry {
  /** The series key (the same key the selection and the table columns use). */
  key: string;
  label: string;
  swatch: ReactNode;
  /** Optional figure after the label (e.g. "€ 1.000 → € 1.200"): muted, not struck through, part of the toggle's accessible name. */
  detail?: string;
  /** false = shown but not an include/exclude control (e.g. a derived line that has no state of its own). */
  toggleable?: boolean;
}

interface LegendProps {
  entries: readonly LegendEntry[];
  selection: SelectionView;
  /** Accessible name of the list. */
  label?: string;
  testId?: string;
  className?: string;
}

const ITEM = 'inline-flex min-h-6 items-center gap-1.5 rounded px-1.5 py-0.5';

type SetFocus = ((key: string | null) => void) | undefined;

/** A mouse or a pen hovers; a finger does not (a tap only toggles, it must not leave the chart dimmed). */
const hovers = (event: PointerEvent): boolean => event.pointerType === 'mouse' || event.pointerType === 'pen';

/** True for keyboard focus; a click also focuses a button but must not start the preview. Engines without `:focus-visible` count as keyboard. */
function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** Pointer handlers of a legend entry: hovering it previews it in the chart. No-ops without `setFocus`. */
export function hoverHandlers(key: string, setFocus: SetFocus) {
  if (!setFocus) return {};
  return {
    onPointerEnter: (event: PointerEvent) => {
      if (hovers(event)) setFocus(key);
    },
    onPointerLeave: (event: PointerEvent) => {
      if (hovers(event)) setFocus(null);
    },
  };
}

/** Keyboard handlers of a legend button: Tab onto it previews it in the chart, Tab away ends the preview. */
export function focusHandlers(key: string, setFocus: SetFocus) {
  if (!setFocus) return {};
  return {
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (isKeyboardFocus(event.currentTarget)) setFocus(key);
    },
    onBlur: () => setFocus(null),
  };
}

interface ToggleProps {
  entry: LegendEntry;
  visible: boolean;
  onToggle: () => void;
  setFocus: SetFocus;
}

function ToggleEntry({ entry, visible, onToggle, setFocus }: Readonly<ToggleProps>) {
  return (
    <button
      type="button"
      aria-pressed={visible}
      onClick={onToggle}
      className={`${ITEM} cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800`}
      {...hoverHandlers(entry.key, setFocus)}
      {...focusHandlers(entry.key, setFocus)}
    >
      <span className={visible ? '' : 'opacity-40'}>{entry.swatch}</span>
      <span className={visible ? '' : 'line-through'}>{entry.label}</span>
      {entry.detail && <span className={`muted tabular-nums ${visible ? '' : 'opacity-40'}`}>{entry.detail}</span>}
    </button>
  );
}

/**
 * Chart legend as HTML buttons: click (or Tab + Enter/Space) to include or exclude a series. Excluded = struck-through text and a dimmed
 * swatch, announced through `aria-pressed="false"`. Drawn above the chart, outside its horizontal scroll area, so it wraps on a phone.
 */
export function SelectableLegend({ entries, selection, label = 'Legend', testId = 'chart-legend', className = '' }: Readonly<LegendProps>) {
  const { focusKey, setFocus } = selection;
  // an entry that leaves the legend (another scope, a toggled option) while previewed would leave the chart dimmed
  const focusPresent = focusKey === null || focusKey === undefined || entries.some((entry) => entry.key === focusKey);
  useEffect(() => {
    if (!focusPresent) setFocus?.(null);
  }, [focusPresent, setFocus]);
  return (
    <div className={`mb-4 ${className}`} data-testid={testId}>
      <ul aria-label={label} className="m-0 flex list-none flex-wrap items-center justify-center gap-x-4 gap-y-1.5 p-0 text-xs">
        {entries.map((entry) => (
          <li key={entry.key}>
            {entry.toggleable === false ? (
              <span className={ITEM} {...hoverHandlers(entry.key, setFocus)}>
                {entry.swatch}
                <span>{entry.label}</span>
                {entry.detail && <span className="muted tabular-nums">{entry.detail}</span>}
              </span>
            ) : (
              <ToggleEntry entry={entry} visible={selection.isSeriesVisible(entry.key)} onToggle={() => selection.toggleSeries(entry.key)} setFocus={setFocus} />
            )}
          </li>
        ))}
        {selection.hasHidden && (
          <li>
            <button type="button" onClick={selection.reset} className={`${ITEM} cursor-pointer font-medium text-brand-700 underline hover:bg-slate-100 dark:text-brand-400 dark:hover:bg-slate-800`}>
              Show all
            </button>
          </li>
        )}
      </ul>
      {selection.hasHidden && <SelectionNote />}
    </div>
  );
}
