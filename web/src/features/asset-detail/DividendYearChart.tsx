import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AssetDividendYear } from '@portfolio/shared';
import { focusOpacity, type SeriesSelection } from '../../components/charts/selection';
import { analyticsTheme, tooltipStyle } from '../../components/charts/analyticsTheme';
import { formatMoney } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';

export interface YearRow {
  year: string;
  complete: number;
  partial: number;
}

/** Complete years and partial ones (running year, first stored year) are separate series so they can be styled apart. */
export const yearRows = (byYear: readonly AssetDividendYear[]): YearRow[] =>
  byYear.map((y) => ({ year: String(y.year), complete: y.complete ? y.perShare : 0, partial: y.complete ? 0 : y.perShare }));

export const perShareTick = (currency: string) => (v: number) => formatMoney(v, currency, { maxDigits: 2 });

export const yearSeriesName = (name: unknown) => (name === 'complete' ? 'Full year' : 'Partial year');

export type YearKind = 'complete' | 'partial';

export const yearKind = (y: AssetDividendYear): YearKind => (y.complete ? 'complete' : 'partial');

/** Row id of a year: the table row and the bar share it. */
export const yearId = (y: AssetDividendYear): string => String(y.year);

/** The series that have data: a legend entry and a table column each (`complete`, `partial`). */
export const yearSeriesKeys = (byYear: readonly AssetDividendYear[]): YearKind[] => (['complete', 'partial'] as const).filter((kind) => byYear.some((y) => yearKind(y) === kind));

/** The years that stay in the chart: not excluded themselves, and their kind (full / partial) is not excluded either. */
export const selectYears = (byYear: readonly AssetDividendYear[], selection: Pick<SeriesSelection, 'isRowVisible' | 'isSeriesVisible'>): AssetDividendYear[] =>
  byYear.filter((y) => selection.isRowVisible(yearId(y)) && selection.isSeriesVisible(yearKind(y)));

/** Text alternative of the chart, for the years that are drawn. */
export function dividendYearLabel(byYear: readonly AssetDividendYear[], currency: string, symbol: string, hasHidden: boolean): string {
  const perYear = byYear.map((y) => y.year + ' ' + formatMoney(y.perShare, currency, { maxDigits: 4 })).join(', ');
  const selection = hasHidden ? ', current selection' : '';
  return `Dividend per share of ${symbol} per year${selection}: ${perYear}.`;
}

interface Props {
  /** The years to draw (the ones that are not excluded). */
  byYear: readonly AssetDividendYear[];
  currency: string;
  showComplete: boolean;
  showPartial: boolean;
  label: string;
  /** The legend entry that is hovered or focused (`complete` or `partial`): that kind of year stays, the other fades. */
  focusKey?: string | null;
}

/** Dividend per share per calendar year. */
export function DividendYearChart({ byYear, currency, showComplete, showPartial, label, focusKey = null }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const rows = useMemo(() => yearRows(byYear), [byYear]);
  const format = (v: unknown, name: unknown): [string, string] => [formatMoney(Number(v), currency, { maxDigits: 4 }), yearSeriesName(name)];
  // a year is one kind or the other, so whichever bar is drawn is the top of its stack
  const top: [number, number, number, number] = [4, 4, 0, 0];
  return (
    <div role="img" aria-label={label} className="chart-focus h-64 w-full" data-testid="asset-dividend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="year" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={perShareTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={64} />
          <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} contentStyle={tooltipStyle(c)} formatter={format} />
          {showComplete && <Bar dataKey="complete" stackId="y" fill={c.received} fillOpacity={focusOpacity(focusKey, 'complete')} strokeOpacity={focusOpacity(focusKey, 'complete')} radius={top} isAnimationActive={false} />}
          {showPartial && <Bar dataKey="partial" stackId="y" fill={c.upcoming} fillOpacity={focusOpacity(focusKey, 'partial')} strokeOpacity={focusOpacity(focusKey, 'partial')} radius={top} isAnimationActive={false} />}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
