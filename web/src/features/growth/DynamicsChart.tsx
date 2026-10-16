import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { GrowthMonthRow } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { formatPercent } from '../../lib/format';
import { analyticsTheme, tooltipStyle } from '../../components/charts/analyticsTheme';
import { arrowOf, benchmarkColors, monthShortLabel, niceAxis, percentTickWith, returnKey } from './growthFormat';

/** "▲ +2,3%": arrow and sign carry the direction, colour only reinforces it. */
export const signedLabel = (value: number, digits = 1): string => `${arrowOf(value)} ${formatPercent(value, { signed: true, digits })}`;

interface LabelProps {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  value?: number | string;
}

export function PercentLabel({ x, y, width, height, value, gain, loss }: Readonly<LabelProps & { gain: string; loss: string }>) {
  const v = Number(value);
  const top = Number(y);
  const bottom = top + Number(height);
  const negative = v < 0;
  return (
    <text x={Number(x) + Number(width) / 2} y={negative ? Math.max(top, bottom) + 13 : Math.min(top, bottom) - 5} fontSize={10} fontWeight={600} textAnchor="middle" fill={negative ? loss : gain}>
      {signedLabel(v)}
    </text>
  );
}

export const dynamicsTooltip = (v: unknown, name: unknown): [string, string] => [signedLabel(Number(v), 2), String(name)];

interface SummaryView {
  /** The portfolio bars are drawn. */
  portfolio: boolean;
  /** Names of the series that are drawn. */
  names: readonly string[];
  /** Something is excluded: say that the chart shows the current selection. */
  hasHidden: boolean;
}

/** Text alternative of the chart, for the months and series that are drawn. */
export function dynamicsSummary(months: readonly GrowthMonthRow[], view: SummaryView): string {
  const first = months[0];
  if (!first) return 'No months selected.';
  const count = `${months.length} months`;
  const selection = view.hasHidden ? ', current selection' : '';
  if (!view.portfolio) return `Monthly returns of ${view.names.join(', ')} over ${count}${selection}.`;
  const best = months.reduce((a, m) => (m.portfolioPct > a.portfolioPct ? m : a), first);
  return `Monthly portfolio return over ${count}${selection}. Best month ${monthShortLabel(best.month)} ${signedLabel(best.portfolioPct)}.`;
}

interface Props {
  months: readonly GrowthMonthRow[];
  /** Benchmarks to show next to the portfolio (empty when Compare is off, or excluded); the index keeps the colour. */
  benchmarks: readonly { symbol: string; index: number }[];
  /** false = the portfolio bars are excluded. */
  showPortfolio: boolean;
  summary: string;
}

/** Monthly returns as columns: green/red portfolio bars with value labels, one neutral bar per benchmark. */
export function DynamicsChart({ months, benchmarks, showPortfolio, summary }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const colors = benchmarkColors(theme);
  const data = months.map((m) => {
    const row: Record<string, string | number | null> = { label: monthShortLabel(m.month) };
    if (showPortfolio) row.portfolio = m.portfolioPct;
    for (const b of benchmarks) row[returnKey(b.index)] = m.benchmarks[b.symbol] ?? null;
    return row;
  });
  const axis = niceAxis(data.flatMap((d) => Object.entries(d).filter(([k]) => k !== 'label').map(([, v]) => Number(v ?? 0))), 0.1);
  // Each month needs room for its bars and the value label above the portfolio bar.
  const minWidth = Math.max(320, months.length * (benchmarks.length + Number(showPortfolio)) * 22 + 60);

  return (
    <div className="overflow-x-auto">
      <div role="img" aria-label={summary} className="h-72 w-full" style={{ minWidth }} data-testid="growth-dynamics-chart">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 22, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="label" stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickMargin={6} interval={0} />
            <YAxis tickFormatter={percentTickWith(axis.digits)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={48} domain={axis.domain} ticks={axis.ticks} />
            <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} contentStyle={tooltipStyle(c)} formatter={dynamicsTooltip} />
            <ReferenceLine y={0} stroke={c.axis} />
            {showPortfolio && (
              <Bar dataKey="portfolio" name="Portfolio" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {data.map((d) => (
                  <Cell key={String(d.label)} fill={Number(d.portfolio) >= 0 ? c.gain : c.loss} />
                ))}
                <LabelList dataKey="portfolio" content={<PercentLabel gain={c.gain} loss={c.loss} />} />
              </Bar>
            )}
            {benchmarks.map((b) => (
              <Bar key={b.symbol} dataKey={returnKey(b.index)} name={b.symbol} fill={colors[b.index % colors.length]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
