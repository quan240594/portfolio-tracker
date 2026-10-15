import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HoldingPerformanceRow } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { analyticsTheme, tooltipStyle } from '../../components/charts/analyticsTheme';
import { signedLabel } from './DynamicsChart';
import { niceAxis, percentTickWith } from './growthFormat';

const ROW_HEIGHT = 30;

interface LabelProps {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  value?: number | string;
}

export function BarValueLabel({ x, y, width, height, value, gain, loss }: Readonly<LabelProps & { gain: string; loss: string }>) {
  const v = Number(value);
  const [a, b] = [Number(x), Number(x) + Number(width)];
  const negative = v < 0;
  return (
    <text x={negative ? Math.min(a, b) - 6 : Math.max(a, b) + 6} y={Number(y) + Number(height) / 2 + 4} fontSize={11} fontWeight={600} textAnchor={negative ? 'end' : 'start'} fill={negative ? loss : gain}>
      {signedLabel(v, 2)}
    </text>
  );
}

export const holdingsTooltip = (v: unknown): [string, string] => [signedLabel(Number(v), 2), 'Return'];

/** Horizontal bars, best holding on top; the axis leaves room on both sides for the value labels. */
export function HoldingsChart({ rows, summary }: Readonly<{ rows: readonly HoldingPerformanceRow[]; summary: string }>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const axis = niceAxis(rows.map((r) => r.returnPct), 0.4);
  const height = rows.length * ROW_HEIGHT + 40;
  return (
    <div className="overflow-x-auto">
      <div role="img" aria-label={summary} style={{ height, minWidth: 480 }} className="w-full" data-testid="growth-holdings-chart">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows as HoldingPerformanceRow[]} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }} barCategoryGap={6}>
            <CartesianGrid stroke={c.grid} horizontal={false} />
            <XAxis
              type="number"
              tickFormatter={percentTickWith(axis.digits)}
              stroke={c.axis}
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              domain={axis.domain}
              ticks={axis.ticks}
            />
            <YAxis type="category" dataKey="symbol" width={84} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval={0} />
            <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} contentStyle={tooltipStyle(c)} formatter={holdingsTooltip} />
            <ReferenceLine x={0} stroke={c.axis} />
            <Bar dataKey="returnPct" radius={3} isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.symbol} fill={r.returnPct >= 0 ? c.gain : c.loss} />
              ))}
              <LabelList dataKey="returnPct" content={<BarValueLabel gain={c.gain} loss={c.loss} />} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
