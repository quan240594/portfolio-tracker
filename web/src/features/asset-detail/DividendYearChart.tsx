import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AssetDividendYear } from '@portfolio/shared';
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

/** Dividend per share per calendar year. */
export function DividendYearChart({ byYear, currency, symbol }: Readonly<{ byYear: readonly AssetDividendYear[]; currency: string; symbol: string }>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const rows = yearRows(byYear);
  const perYear = byYear.map((y) => y.year + ' ' + formatMoney(y.perShare, currency, { maxDigits: 4 })).join(', ');
  const label = `Dividend per share of ${symbol} per year: ${perYear}.`;
  const format = (v: unknown, name: unknown): [string, string] => [formatMoney(Number(v), currency, { maxDigits: 4 }), yearSeriesName(name)];
  return (
    <div role="img" aria-label={label} className="h-64 w-full" data-testid="asset-dividend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="year" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={perShareTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={64} />
          <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} contentStyle={tooltipStyle(c)} formatter={format} />
          <Bar dataKey="complete" stackId="y" fill={c.received} isAnimationActive={false} />
          <Bar dataKey="partial" stackId="y" fill={c.upcoming} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
