import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ValuePoint } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { formatDate, formatMoney } from '../../lib/format';
import { chartTheme } from './palette';
import { compactMoneyTick, dateLabel, dateTickFormatter, moneyTooltip, valueSeriesName } from './chartFormatters';
import { LegendSwatch, NothingSelected, SelectableLegend, useSeriesSelection } from './selection';

const SERIES_KEYS = ['value', 'invested'];

interface Props {
  points: ValuePoint[];
  currency: string;
}

interface Shown {
  value: boolean;
  invested: boolean;
}

/** Text alternative of the chart; it only mentions the series that are drawn. */
export function valueSummary(points: readonly ValuePoint[], currency: string, shown: Shown = { value: true, invested: true }): string {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return 'No history available.';
  const span = `from ${formatDate(first.date)} to ${formatDate(last.date)}`;
  if (!shown.value) return `Invested ${span}: ${formatMoney(first.invested, currency)} to ${formatMoney(last.invested, currency)}.`;
  const value = `Portfolio value ${span}: ${formatMoney(first.value, currency)} to ${formatMoney(last.value, currency)}`;
  return shown.invested ? `${value}; invested ${formatMoney(last.invested, currency)}.` : `${value}.`;
}

/** Value and invested lines with a legend that includes or excludes each series (a time series: no data table, the days cannot be excluded). */
export function ValueChart({ points, currency }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = chartTheme(theme);
  const selection = useSeriesSelection(SERIES_KEYS);
  const shown = { value: selection.isSeriesVisible('value'), invested: selection.isSeriesVisible('invested') };
  const summary = valueSummary(points, currency, shown);
  const entries = [
    { key: 'value', label: 'Value', swatch: <LegendSwatch shape="line" color={c.value} /> },
    { key: 'invested', label: 'Invested', swatch: <LegendSwatch shape="line" color={c.invested} dashed /> },
  ];

  return (
    <div>
      <SelectableLegend entries={entries} selection={selection} label="Chart series" testId="value-legend" />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <div role="img" aria-label={selection.hasHidden ? `${summary} Chart shows the current selection.` : summary} className="h-72 w-full" data-testid="value-chart">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={c.value} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={c.value} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="date" tickFormatter={dateTickFormatter(points)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={40} />
              <YAxis tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={64} domain={['auto', 'auto']} />
              <Tooltip
                contentStyle={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 8, color: c.text, fontSize: 12 }}
                labelFormatter={dateLabel}
                formatter={moneyTooltip(currency, valueSeriesName)}
              />
              {shown.value && <Area type="monotone" dataKey="value" stroke={c.value} strokeWidth={2} fill="url(#valueFill)" isAnimationActive={false} />}
              {shown.invested && <Line type="stepAfter" dataKey="invested" stroke={c.invested} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
