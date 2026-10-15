import type { CSSProperties } from 'react';
import { gaugePosition, type GaugeScale, type VerdictTone } from '@portfolio/shared';

export interface GaugeMarker {
  key: 'portfolio' | 'benchmark';
  /** "You" / "Market"; the visible and spoken name of the marker. */
  label: string;
  value: number | null;
  /** The formatted value shown next to the label. */
  text: string;
}

export interface GaugeBand {
  from: number;
  to: number;
  tone: VerdictTone;
}

interface Props {
  /** Accessible name of the gauge, e.g. "Sharpe ratio". */
  label: string;
  scale: GaugeScale;
  markers: readonly GaugeMarker[];
  /** Coloured zones of the scale; a neutral track without them. */
  bands?: readonly GaugeBand[];
  ticks: readonly number[];
  formatTick: (value: number) => string;
  /** Appended to the text equivalent, e.g. "Verdict: requires attention." */
  verdict?: string;
  /** Captions under the left and right end of the scale, e.g. ["Lower volatility", "Higher"]. */
  endLabels?: readonly [string, string];
}

const BAND_CLASS: Record<VerdictTone, string> = {
  negative: 'bg-red-300 dark:bg-red-500/50',
  caution: 'bg-amber-300 dark:bg-amber-500/50',
  neutral: 'bg-sky-300 dark:bg-sky-500/50',
  positive: 'bg-emerald-300 dark:bg-emerald-500/50',
};
const NEUTRAL_TRACK = 'bg-gradient-to-r from-slate-200 to-slate-300 dark:from-slate-700 dark:to-slate-600';
const LABEL_EDGE = 0.15;
/** Ticks are short, so only the scale's own ends are pinned; neighbouring ticks never collide. */
const TICK_EDGE = 0.01;

const percent = (fraction: number) => `${(fraction * 100).toFixed(2)}%`;

/** Keeps a label inside the gauge: centred on its position, pinned to the edge once closer than `edge` to either end. */
function placement(position: number, edge: number): { style: CSSProperties; align: string } {
  if (position < edge) return { style: { left: 0 }, align: 'text-left' };
  if (position > 1 - edge) return { style: { right: 0 }, align: 'text-right' };
  return { style: { left: percent(position), transform: 'translateX(-50%)' }, align: 'text-center' };
}

function MarkerLabel({ marker, scale, row }: Readonly<{ marker: GaugeMarker; scale: GaugeScale; row: string }>) {
  if (marker.value === null) return null;
  const { style, align } = placement(gaugePosition(marker.value, scale), LABEL_EDGE);
  return (
    <span className={`absolute ${row} text-xs whitespace-nowrap ${align}`} style={style} data-testid={`gauge-label-${marker.key}`}>
      <span className="muted">{marker.label} </span>
      <span className="font-semibold tabular-nums">{marker.text}</span>
    </span>
  );
}

function Dot({ marker, scale }: Readonly<{ marker: GaugeMarker; scale: GaugeScale }>) {
  if (marker.value === null) return null;
  const look =
    marker.key === 'portfolio'
      ? 'z-10 h-4 w-4 bg-brand-600 ring-2 ring-white dark:bg-brand-400 dark:ring-slate-900'
      : 'z-0 h-3.5 w-3.5 border-2 border-slate-600 bg-white dark:border-slate-300 dark:bg-slate-900';
  return (
    <span
      className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${look}`}
      style={{ left: percent(gaugePosition(marker.value, scale)) }}
      data-testid={`gauge-dot-${marker.key}`}
    />
  );
}

function Tick({ value, scale, format }: Readonly<{ value: number; scale: GaugeScale; format: (v: number) => string }>) {
  const { style, align } = placement(gaugePosition(value, scale), TICK_EDGE);
  return (
    <span className={`muted absolute text-[11px] tabular-nums ${align}`} style={style}>
      {format(value)}
    </span>
  );
}

function textEquivalent(label: string, markers: readonly GaugeMarker[], scale: GaugeScale, format: (v: number) => string, verdict?: string): string {
  const parts = markers.map((m) => `${m.label}: ${m.value === null ? 'not available' : m.text}`);
  const range = `Scale from ${format(scale.min)} to ${format(scale.max)}.`;
  return [`${label}. ${parts.join('; ')}.`, range, verdict].filter(Boolean).join(' ');
}

/**
 * Horizontal gauge with markers for the portfolio (filled dot, label above) and the market (hollow dot, label below).
 * Colour is never the only signal: the markers carry their values as text, a native `<meter>` exposes the
 * portfolio value, and a text equivalent spells out both values, the scale and the verdict.
 */
export function Gauge({ label, scale, markers, bands, ticks, formatTick, verdict, endLabels }: Readonly<Props>) {
  const portfolio = markers.find((m) => m.key === 'portfolio');
  const benchmark = markers.find((m) => m.key === 'benchmark');
  const portfolioValue = portfolio?.value ?? null;
  const span = scale.max - scale.min;
  return (
    <figure className="m-0" aria-label={label}>
      <div aria-hidden="true">
        <div className="relative h-5">{portfolio && <MarkerLabel marker={portfolio} scale={scale} row="bottom-0" />}</div>
        <div className="relative h-5">
          <div className={`absolute inset-x-0 top-1/2 flex h-2.5 -translate-y-1/2 overflow-hidden rounded-full ${bands ? '' : NEUTRAL_TRACK}`}>
            {bands?.map((b) => (
              <span key={`${b.from}-${b.to}`} className={BAND_CLASS[b.tone]} style={{ width: percent((b.to - b.from) / span) }} />
            ))}
          </div>
          {benchmark && <Dot marker={benchmark} scale={scale} />}
          {portfolio && <Dot marker={portfolio} scale={scale} />}
        </div>
        <div className="relative h-5">{benchmark && <MarkerLabel marker={benchmark} scale={scale} row="top-0.5" />}</div>
        <div className="relative h-4">
          {ticks.map((t) => (
            <Tick key={t} value={t} scale={scale} format={formatTick} />
          ))}
        </div>
        {endLabels && (
          <div className="muted mt-1 flex justify-between text-xs">
            <span>{endLabels[0]}</span>
            <span>{endLabels[1]}</span>
          </div>
        )}
      </div>
      {portfolioValue !== null && (
        <meter className="sr-only" min={scale.min} max={scale.max} value={Math.min(scale.max, Math.max(scale.min, portfolioValue))} aria-label={`${label}, portfolio`} />
      )}
      <figcaption className="sr-only">{textEquivalent(label, markers, scale, formatTick, verdict)}</figcaption>
    </figure>
  );
}
