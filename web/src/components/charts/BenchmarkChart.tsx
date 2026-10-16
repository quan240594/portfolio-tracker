import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { BenchmarkPoint } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { formatDate, formatMoney } from '../../lib/format';
import { compactMoneyTick, dateLabel, dateTickFormatter, moneyTooltip } from './chartFormatters';
import { analyticsTheme, tooltipStyle } from './analyticsTheme';
import { LegendSwatch, NothingSelected, SelectableLegend, useSeriesSelection } from './selection';

interface Props {
  points: readonly BenchmarkPoint[];
  currency: string;
  benchmark: string;
}

export const benchmarkSeriesName = (benchmark: string) => (name: unknown) => {
  if (name === 'portfolio') return 'Portfolio';
  return name === 'benchmark' ? benchmark : 'Invested';
};

export interface BenchmarkShown {
  portfolio: boolean;
  benchmark: boolean;
  invested: boolean;
}

const ALL_SHOWN: BenchmarkShown = { portfolio: true, benchmark: true, invested: true };

/** Text alternative for the chart: portfolio value over the period, plus the benchmark's end value when there is one; it only mentions the series that are drawn. */
export function benchmarkSummary(points: readonly BenchmarkPoint[], currency: string, benchmark: string, shown: BenchmarkShown = ALL_SHOWN): string {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return 'No history available.';
  const span = `from ${formatDate(first.date)} to ${formatDate(last.date)}`;
  const replayed = `${benchmark} replayed with the same cash flows`;
  const hasBenchmark = shown.benchmark && last.benchmark !== null && last.benchmark !== undefined;
  const sentences: string[] = [];
  if (shown.portfolio) {
    const portfolio = `Portfolio value ${span}: ${formatMoney(first.portfolio, currency)} to ${formatMoney(last.portfolio, currency)}`;
    sentences.push(hasBenchmark ? `${portfolio}, against ${replayed}: ${formatMoney(last.benchmark!, currency)}.` : `${portfolio}.`);
  } else if (hasBenchmark) {
    sentences.push(`${replayed} ended at ${formatMoney(last.benchmark!, currency)}.`);
  }
  if (shown.invested && !shown.portfolio) sentences.push(`Invested ${span}: ${formatMoney(first.invested, currency)} to ${formatMoney(last.invested, currency)}.`);
  return sentences.join(' ');
}

/** The portfolio, the benchmark replayed with the same cash flows and the invested amount. A time series: the legend includes or excludes a series, there is no data table (single days cannot be excluded). */
export function BenchmarkChart({ points, currency, benchmark }: Readonly<Props>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const lastBenchmark = points.at(-1)?.benchmark;
  const hasBenchmark = lastBenchmark !== null && lastBenchmark !== undefined;
  const selection = useSeriesSelection(hasBenchmark ? ['portfolio', 'benchmark', 'invested'] : ['portfolio', 'invested']);
  const shown = { portfolio: selection.isSeriesVisible('portfolio'), benchmark: selection.isSeriesVisible('benchmark'), invested: selection.isSeriesVisible('invested') };
  const summary = benchmarkSummary(points, currency, benchmark, shown);
  const nameOf = benchmarkSeriesName(benchmark);
  const entries = [
    { key: 'portfolio', label: nameOf('portfolio'), swatch: <LegendSwatch shape="line" color={c.value} /> },
    ...(hasBenchmark ? [{ key: 'benchmark', label: nameOf('benchmark'), swatch: <LegendSwatch shape="line" color={c.benchmark} /> }] : []),
    { key: 'invested', label: nameOf('invested'), swatch: <LegendSwatch shape="line" color={c.invested} dashed /> },
  ];

  return (
    <div>
      <SelectableLegend entries={entries} selection={selection} label="Chart series" testId="benchmark-legend" />
      {selection.nothingSelected ? (
        <NothingSelected onShowAll={selection.reset} />
      ) : (
        <div role="img" aria-label={selection.hasHidden ? `${summary} Chart shows the current selection.` : summary} className="h-72 w-full" data-testid="benchmark-chart">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points as BenchmarkPoint[]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="date" tickFormatter={dateTickFormatter(points)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={40} />
              <YAxis tickFormatter={compactMoneyTick(currency)} stroke={c.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={64} domain={['auto', 'auto']} />
              <Tooltip contentStyle={tooltipStyle(c)} labelFormatter={dateLabel} formatter={moneyTooltip(currency, nameOf)} />
              {shown.portfolio && <Line type="monotone" dataKey="portfolio" stroke={c.value} strokeWidth={2} dot={false} isAnimationActive={false} />}
              {hasBenchmark && shown.benchmark && <Line type="monotone" dataKey="benchmark" stroke={c.benchmark} strokeWidth={2} dot={false} isAnimationActive={false} />}
              {shown.invested && <Line type="stepAfter" dataKey="invested" stroke={c.invested} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
