import { useState } from 'react';
import type { AnalyticsReturnsResponse, ReturnPeriod } from '@portfolio/shared';
import { useAnalyticsReturns } from '../../api/analyticsHooks';
import { Change } from '../../components/Change';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SegmentedControl } from '../../components/SegmentedControl';
import { ReturnsBarChart } from '../../components/charts/ReturnsBarChart';
import { formatMoney } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { periodLabel, signedPercentOrDash } from './labels';
import { PanelHeader, TableShell, numCell, rowClass } from './TableShell';

const PERIOD_OPTIONS: { value: ReturnPeriod; label: string }[] = [
  { value: 'year', label: 'Year' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'month', label: 'Month' },
];
/** Most recent periods shown per granularity. */
const MAX_PERIODS: Record<ReturnPeriod, number> = { year: 10, quarter: 12, month: 24 };

function ReturnsContent({ data }: Readonly<{ data: AnalyticsReturnsResponse }>) {
  const rows = data.rows.slice(-MAX_PERIODS[data.period]);
  if (rows.length === 0) return <p className="muted py-8 text-center text-sm">Not enough history yet to calculate returns.</p>;
  const showIrr = data.period === 'year';
  const columns = [
    { label: 'Period' },
    { label: 'Return (TWR)', align: 'right' as const },
    ...(showIrr ? [{ label: 'IRR', align: 'right' as const }] : []),
    { label: 'Gain', align: 'right' as const },
    { label: 'End value', align: 'right' as const },
  ];
  return (
    <div className="space-y-5">
      <ReturnsBarChart rows={rows} period={data.period} />
      <TableShell caption={`Returns per ${data.period}, newest first`} columns={columns}>
        {[...rows].reverse().map((r) => (
          <tr key={r.period} className={rowClass}>
            <th scope="row" className="py-2 pr-3 text-left font-medium whitespace-nowrap">
              {periodLabel(data.period, r.period)}
            </th>
            <td className={numCell}>
              <Change pct={r.twrPct} />
            </td>
            {showIrr && <td className={numCell}>{signedPercentOrDash(r.irrPct)}</td>}
            <td className={numCell}>
              <Change amount={r.gain} currency={data.baseCurrency} />
            </td>
            <td className={`${numCell} font-medium`}>{formatMoney(r.endValue, data.baseCurrency)}</td>
          </tr>
        ))}
      </TableShell>
      <p className="muted text-xs">
        Time-weighted return (TWR) removes the effect of deposits and withdrawals, so it measures how your investments performed. The IRR
        is money-weighted and also reflects when you invested; for a year that is not complete yet it is the return over the period, not annualised.
        Both include dividends.
      </p>
    </div>
  );
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
