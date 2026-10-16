import { useState } from 'react';
import type { AnalyticsReturnsResponse, ReturnPeriod } from '@portfolio/shared';
import { useAnalyticsReturns } from '../../api/analyticsHooks';
import { Change } from '../../components/Change';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SegmentedControl } from '../../components/SegmentedControl';
import { ReturnsBarChart } from '../../components/charts/ReturnsBarChart';
import { LegendSwatch, NothingSelected, SelectableLegend, SelectableTable, selectRows, useSeriesSelection } from '../../components/charts/selection';
import { analyticsTheme } from '../../components/charts/analyticsTheme';
import { useTheme } from '../../theme/ThemeProvider';
import { formatMoney } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { periodLabel, signedPercentOrDash } from './labels';
import { PanelHeader } from './TableShell';

const PERIOD_OPTIONS: { value: ReturnPeriod; label: string }[] = [
  { value: 'year', label: 'Year' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'month', label: 'Month' },
];
/** Most recent periods shown per granularity. */
const MAX_PERIODS: Record<ReturnPeriod, number> = { year: 10, quarter: 12, month: 24 };

const SERIES = ['twrPct'];

/** The bars are green or red by sign: the legend key shows both. */
function SignSwatch({ gain, loss }: Readonly<{ gain: string; loss: string }>) {
  return (
    <span className="inline-flex gap-0.5">
      <LegendSwatch color={gain} />
      <LegendSwatch color={loss} />
    </span>
  );
}

/** Chart, legend and table of one granularity. A period is a row: the legend (the one TWR series) and the row headers include or exclude it. */
function ReturnsBody({ data, rows }: Readonly<{ data: AnalyticsReturnsResponse; rows: AnalyticsReturnsResponse['rows'] }>) {
  const { theme } = useTheme();
  const c = analyticsTheme(theme);
  const selection = useSeriesSelection(SERIES, rows.map((r) => r.period));
  const showIrr = data.period === 'year';
  const columns = [
    { key: 'twrPct', label: 'Return (TWR)' },
    ...(showIrr ? [{ key: 'irr', label: 'IRR', selectable: false }] : []),
    { key: 'gain', label: 'Gain', selectable: false },
    { key: 'endValue', label: 'End value', selectable: false },
  ];
  const tableRows = [...rows].reverse().map((r) => ({
    id: r.period,
    header: periodLabel(data.period, r.period),
    cells: [
      <Change key="twr" pct={r.twrPct} />,
      ...(showIrr ? [signedPercentOrDash(r.irrPct)] : []),
      <Change key="gain" amount={r.gain} currency={data.baseCurrency} />,
      <span key="end" className="font-medium">
        {formatMoney(r.endValue, data.baseCurrency)}
      </span>,
    ],
  }));
  const shown = selectRows(rows, (r) => r.period, selection);
  return (
    <div className="space-y-5">
      <div>
        <SelectableLegend
          label="Chart series"
          testId="returns-legend"
          selection={selection}
          entries={[{ key: 'twrPct', label: 'Return (TWR)', swatch: <SignSwatch gain={c.gain} loss={c.loss} /> }]}
        />
        {selection.nothingSelected ? <NothingSelected onShowAll={selection.reset} /> : <ReturnsBarChart rows={shown} period={data.period} filtered={selection.hasHidden} />}
      </div>
      <SelectableTable caption={`Returns per ${data.period}, newest first`} rowHeader="Period" columns={columns} rows={tableRows} selection={selection} tableClassName="w-full text-sm" scrollClassName="overflow-x-auto" />
      <p className="muted text-xs">
        Time-weighted return (TWR) removes the effect of deposits and withdrawals, so it measures how your investments performed. The IRR
        is money-weighted and also reflects when you invested; for a year that is not complete yet it is the return over the period, not annualised.
        Both include dividends. The chart follows the periods and series you include in the legend or the table.
      </p>
    </div>
  );
}

function ReturnsContent({ data }: Readonly<{ data: AnalyticsReturnsResponse }>) {
  const rows = data.rows.slice(-MAX_PERIODS[data.period]);
  if (rows.length === 0) return <p className="muted py-8 text-center text-sm">Not enough history yet to calculate returns.</p>;
  return <ReturnsBody data={data} rows={rows} />;
}

export function ReturnsTab() {
  const [period, setPeriod] = useState<ReturnPeriod>('year');
  const { scope, ready } = usePortfolioScope();
  const query = useAnalyticsReturns(scope, period, { enabled: ready });
  return (
    <section aria-labelledby="returns-title">
      <PanelHeader
        id="returns-title"
        title="Returns by period"
        controls={<SegmentedControl label="Return period" options={PERIOD_OPTIONS} value={period} onChange={setPeriod} />}
      />
      <QueryBoundary query={query} loadingLabel="Loading returns" errorTitle="Could not load returns">
        {(data) => <ReturnsContent data={data} />}
      </QueryBoundary>
    </section>
  );
}
