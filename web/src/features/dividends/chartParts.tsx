import { useEffect, useRef, type ReactNode } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { useTheme } from '../../theme/ThemeProvider';
import { analyticsTheme, tooltipStyle } from '../../components/charts/analyticsTheme';
import { formatMoney } from '../../lib/format';
import { incomeColours } from '../calendar/calendarColours';

/** Chart colours of the dividends page: the analytics palette plus the calendar's status colours (received = pastel green, declared = pastel blue, estimated = pastel yellow, each with a darker edge), so a status looks the same on both pages. */
export function useDividendTheme() {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const { paid, declared, estimated } = incomeColours(theme);
  return {
    ...c,
    paid: paid.fill,
    paidEdge: paid.stroke,
    declared: declared.fill,
    declaredEdge: declared.stroke,
    estimated: estimated.fill,
    estimatedEdge: estimated.stroke,
    tooltip: tooltipStyle(c),
  };
}

/** Width of one bar slot; charts with more bars than fit scroll sideways instead of squeezing the labels. */
export const SLOT_PX = 44;

interface FrameProps {
  label: string;
  testId: string;
  bars?: number;
  height?: string;
  /** Start scrolled to the right edge (a series whose newest part matters most). */
  scrollToEnd?: boolean;
  /** Index of the bar to scroll to the middle of a wide chart (e.g. the current period); the start when omitted. */
  focusBar?: number;
  /** A fixed value axis shown left of the scrolling bars, so it stays in view while the chart scrolls. */
  axis?: ReactNode;
  children: ReactNode;
}

/** Accessible chart container: the label is the text alternative; wide charts scroll horizontally. */
export function ChartFrame({ label, testId, bars = 0, height = 'h-72', scrollToEnd = false, focusBar, axis, children }: Readonly<FrameProps>) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (scrollToEnd) el.scrollLeft = el.scrollWidth;
    else if (focusBar !== undefined && bars > 0) el.scrollLeft = (focusBar + 0.5) * (el.scrollWidth / bars) - el.clientWidth / 2;
  }, [scrollToEnd, focusBar, bars]);
  const scrolling = (
    <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto">
      <div role="img" aria-label={label} data-testid={testId} className={`${height} w-full`} style={{ minWidth: bars * SLOT_PX }}>
        {children}
      </div>
    </div>
  );
  if (!axis) return scrolling;
  return (
    <div className="flex">
      <div aria-hidden="true" className={`${height} w-14 shrink-0`}>
        {axis}
      </div>
      {scrolling}
    </div>
  );
}

interface TableProps {
  caption: string;
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
  className?: string;
}

/** A plain data table (the numbers behind a chart). */
export function DataGrid({ caption, columns, rows, className = '' }: Readonly<TableProps>) {
  return (
    <table className={`w-full text-xs ${className}`}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="muted border-b border-slate-200 text-left dark:border-slate-800">
          {columns.map((c, i) => (
            <th key={c} scope="col" className={`py-1.5 pr-3 font-medium ${i === 0 ? '' : 'text-right'}`}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={String(row[0])} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
            {row.map((cell, i) => (
              <td key={columns[i]} className={`py-1.5 pr-3 tabular-nums ${i === 0 ? 'font-medium' : 'text-right'}`}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The chart's numbers as a table, one click away: the keyboard / screen reader alternative to the graphic. `extra` adds more tables below the first. */
export function ChartDataTable({ caption, columns, rows, extra }: Readonly<TableProps & { extra?: ReactNode }>) {
  return (
    <details className="mt-2 text-xs">
      <summary className="muted w-fit cursor-pointer rounded px-1 select-none hover:text-slate-900 dark:hover:text-white">Show data table</summary>
      <div className="mt-2 max-h-64 overflow-auto">
        <DataGrid caption={caption} columns={columns} rows={rows} />
        {extra}
      </div>
    </details>
  );
}

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

interface DonutProps {
  slices: readonly DonutSlice[];
  label: string;
  testId: string;
  /** Tooltip value formatter; defaults to EUR amounts. */
  format?: (value: number) => string;
}

export function Donut({ slices, label, testId, format = (v) => formatMoney(v, 'EUR') }: Readonly<DonutProps>) {
  const c = useDividendTheme();
  return (
    <div role="img" aria-label={label} data-testid={testId} className="mx-auto h-44 w-44 shrink-0 sm:h-52 sm:w-52">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={slices as DonutSlice[]} dataKey="value" nameKey="label" innerRadius="60%" outerRadius="100%" paddingAngle={1.5} stroke="none" isAnimationActive={false}>
            {slices.map((s) => (
              <Cell key={s.key} fill={s.color} />
            ))}
          </Pie>
          <Tooltip contentStyle={c.tooltip} itemStyle={{ color: c.text }} formatter={(v: unknown, name: unknown) => [format(Number(v)), String(name)]} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
