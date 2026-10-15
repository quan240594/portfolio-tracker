import { useId, type CSSProperties } from 'react';
import { formatMoney } from '../../lib/format';
import { ToggleGroup } from '../calendar/CalendarControls';
import { useDividendTheme } from './chartParts';
import {
  GROWTH_VIEWS,
  NEEDS_HISTORY_NOTE,
  tooltipLinesOfTimeline,
  yearTooltipLines,
  type GrowthView,
  type LegendItem,
  type SwatchKind,
  type TimelineRow,
  type TooltipLine,
  type YearForecastModel,
  type YearRow,
} from './growthForecast';

type Theme = ReturnType<typeof useDividendTheme>;

const LINE_STYLE: Record<'average' | 'yearAverage' | 'trend' | 'projection', { solid: boolean; colour: (c: Theme) => string }> = {
  average: { solid: true, colour: (c) => c.invested },
  yearAverage: { solid: false, colour: (c) => c.invested },
  trend: { solid: true, colour: (c) => c.value },
  projection: { solid: false, colour: (c) => c.value },
};

function barStyle(kind: SwatchKind, c: Theme, color?: string): CSSProperties {
  if (kind === 'estimated') return { background: c.estimated, border: `1px dashed ${c.estimatedEdge}` };
  if (kind === 'declared' || kind === 'forecastYear') return { background: c.declared, border: `1px solid ${c.declaredEdge}` };
  return { background: color };
}

/** Small key of a series: a filled square for bars (declared = solid edge, estimated = dashed edge), a line piece for lines. */
export function Swatch({ kind, color, c }: Readonly<{ kind: SwatchKind; color?: string; c: Theme }>) {
  if (kind === 'average' || kind === 'yearAverage' || kind === 'trend' || kind === 'projection') {
    const { solid, colour } = LINE_STYLE[kind];
    return <span aria-hidden="true" className="inline-block w-4 border-t-2" style={{ borderTopStyle: solid ? 'solid' : 'dashed', borderTopColor: colour(c) }} />;
  }
  return <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={barStyle(kind, c, color)} />;
}

interface LegendProps {
  items: readonly LegendItem[];
  c: Theme;
}

/** Own legend, drawn above the chart (outside its horizontal scroll area, so it wraps and stays visible on a phone): swatch + readable text instead of recharts' legend text in the, often pastel, series colour. */
export function GrowthLegend({ items, c }: Readonly<LegendProps>) {
  return (
    <ul className="m-0 mb-2 flex list-none flex-wrap justify-center gap-x-4 gap-y-1 p-0 text-xs" style={{ color: c.text }} data-testid="growth-legend">
      {items.map((item) => (
        <li key={item.key} className="inline-flex items-center gap-1.5">
          <Swatch kind={item.swatch} color={item.color} c={c} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

interface TooltipEntry {
  payload?: unknown;
}

interface BoxProps {
  title: string;
  lines: readonly TooltipLine[];
  ccy: string;
  c: Theme;
  colorOf?: (year: string) => string;
}

const KIND_SWATCH: Record<TooltipLine['kind'], SwatchKind> = { received: 'received', declared: 'declared', estimated: 'estimated', average: 'average', trend: 'trend' };

/** Tooltip body: one row per series, a swatch plus a text label, so nothing relies on colour alone. */
export function TooltipBox({ title, lines, ccy, c, colorOf }: Readonly<BoxProps>) {
  return (
    <div className="rounded-lg px-3 py-2 text-xs" style={c.tooltip}>
      <p className="mb-1 font-medium">{title}</p>
      <ul className="m-0 list-none space-y-0.5 p-0">
        {lines.map((line) => (
          <li key={line.key} className="flex items-center justify-between gap-4">
            <span className="inline-flex items-center gap-1.5">
              <Swatch kind={line.kind === 'received' && line.year ? 'year' : KIND_SWATCH[line.kind]} color={line.year && colorOf ? colorOf(line.year) : undefined} c={c} />
              {line.label}
            </span>
            <span className="font-medium tabular-nums">{formatMoney(line.value, ccy)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const rowOf = <T,>(payload: unknown): T | undefined => (Array.isArray(payload) ? ((payload[0] as TooltipEntry | undefined)?.payload as T | undefined) : undefined);

interface YearTooltipProps {
  active?: boolean;
  payload?: unknown;
  model: YearForecastModel;
  ccy: string;
  c: Theme;
  colorOf: (year: string) => string;
}

/** Tooltip of the grouped chart (one calendar month, every year, forecast rows labelled "forecast"). */
export function YearTooltip({ active, payload, model, ccy, c, colorOf }: Readonly<YearTooltipProps>) {
  const row = rowOf<YearRow>(payload);
  if (!active || !row) return null;
  return <TooltipBox title={row.month} lines={yearTooltipLines(row, model)} ccy={ccy} c={c} colorOf={colorOf} />;
}

interface TimelineTooltipProps {
  active?: boolean;
  payload?: unknown;
  ccy: string;
  c: Theme;
}

export function TimelineTooltip({ active, payload, ccy, c }: Readonly<TimelineTooltipProps>) {
  const row = rowOf<TimelineRow>(payload);
  if (!active || !row) return null;
  const forecast = row.declared !== undefined || row.estimated !== undefined;
  return <TooltipBox title={`${row.label}${forecast ? ' · Forecast' : ''}`} lines={tooltipLinesOfTimeline(row)} ccy={ccy} c={c} />;
}

interface ControlsProps {
  view: GrowthView;
  onView: (view: GrowthView) => void;
  showForecast: boolean;
  onShowForecast: (show: boolean) => void;
  forecastAvailable: boolean;
}

/** "By year" / "Timeline" (native radios) and the "Show forecast" checkbox. */
export function GrowthControls({ view, onView, showForecast, onShowForecast, forecastAvailable }: Readonly<ControlsProps>) {
  const id = useId();
  return (
    <>
      <ToggleGroup legend="Chart view" options={GROWTH_VIEWS} value={view} onChange={onView} />
      <label className="flex items-center gap-1.5 text-xs" htmlFor={id}>
        <input id={id} type="checkbox" checked={showForecast && forecastAvailable} disabled={!forecastAvailable} onChange={(e) => onShowForecast(e.target.checked)} />
        <span>Show forecast</span>
      </label>
    </>
  );
}

/** "Forecast next 12 months: … · Trend: …" under the chart. */
export function ForecastSummary({ parts }: Readonly<{ parts: readonly string[] }>) {
  if (parts.length === 0) return null;
  return (
    <p className="mt-2 text-xs font-medium tabular-nums" data-testid="forecast-summary">
      {parts.join(' · ')}
    </p>
  );
}

export function TrendNote() {
  return (
    <p className="muted mt-2 text-xs" data-testid="trend-note">
      {NEEDS_HISTORY_NOTE}
    </p>
  );
}

/** "How is this calculated?" for the forecast and the trend: the formulas and the limitation. */
export function TrendMethod() {
  return (
    <details className="mt-2 text-xs text-slate-700 dark:text-slate-300" data-testid="trend-method">
      <summary className="w-fit cursor-pointer rounded font-medium text-brand-700 select-none hover:underline dark:text-brand-400">How is this calculated?</summary>
      <div className="mt-2 space-y-2 leading-relaxed">
        <p>
          <strong>Forecast.</strong> The bars after today are the months of the Future payments card: declared = announced dividends × the shares you hold, estimated = the payments your history implies, placed in the months you were paid last year. They add up to its 12-month total. In the current month the bar shows what you received so far plus what is still expected.
        </p>
        <p>
          <strong>12-month average.</strong> The mean of the dividends received in the last 12 complete months (fewer at the start of your history), drawn from the 6th month of history on. Months without dividends count as € 0.
        </p>
        <p>
          <strong>Trend.</strong> A straight line y = a + b·x fitted by least squares to the dividends received in the last 24 complete months (at most; x = 0 for the oldest month): b = Σ(x − x̄)(y − ȳ) / Σ(x − x̄)², a = ȳ − b·x̄. It is extended as a dashed line over the current month and the 12 forecast months and never drops below € 0. &quot;Trend: +€ Y/month per year&quot; is 12 × b: how much your monthly dividend income rises (or falls) per year. The current month is incomplete and not part of the fit. It needs at least 6 months of history.
        </p>
        <p>
          <strong>Average of years</strong> (By year view): for each calendar month the mean over the shown years in which that month is complete; months with data in only one year are left out.
        </p>
        <p>The trend extrapolates the past and the forecast is an estimate. Neither is a promise: companies can cut, skip or raise dividends. Not investment advice.</p>
      </div>
    </details>
  );
}
