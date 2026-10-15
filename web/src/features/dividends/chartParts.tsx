import type { ReactNode } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { useTheme } from '../../theme/ThemeProvider';
import { analyticsTheme, tooltipStyle } from '../../components/charts/analyticsTheme';
import { formatMoney } from '../../lib/format';

/** Chart colours of the dividends page: the analytics palette plus a lighter shade for estimated income. */
export function useDividendTheme() {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  return { ...c, estimated: theme === 'dark' ? '#4c51bf' : '#a5b4fc', tooltip: tooltipStyle(c) };
}

/** Width of one bar slot; charts with more bars than fit scroll sideways instead of squeezing the labels. */
const SLOT_PX = 44;

interface FrameProps {
  label: string;
  testId: string;
  bars?: number;
  height?: string;
  children: ReactNode;
}

/** Accessible chart container: the label is the text alternative; wide charts scroll horizontally. */
export function ChartFrame({ label, testId, bars = 0, height = 'h-72', children }: Readonly<FrameProps>) {
  return (
    <div className="overflow-x-auto">
      <div role="img" aria-label={label} data-testid={testId} className={`${height} w-full`} style={{ minWidth: bars * SLOT_PX }}>
        {children}
      </div>
    </div>
  );
}

interface TableProps {
  caption: string;
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
}

/** The chart's numbers as a table, one click away: the keyboard / screen reader alternative to the graphic. */
export function ChartDataTable({ caption, columns, rows }: Readonly<TableProps>) {
  return (
    <details className="mt-2 text-xs">
      <summary className="muted w-fit cursor-pointer rounded px-1 select-none hover:text-slate-900 dark:hover:text-white">Show data table</summary>
      <div className="mt-2 max-h-64 overflow-auto">
        <table className="w-full text-xs">
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
