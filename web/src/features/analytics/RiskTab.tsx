import { useState } from 'react';
import { BENCHMARK_SYMBOLS, MIN_RISK_OBSERVATIONS, type AnalyticsRiskResponse } from '@portfolio/shared';
import { useAnalyticsRisk } from '../../api/analyticsHooks';
import { QueryBoundary } from '../../components/QueryBoundary';
import { SegmentedControl } from '../../components/SegmentedControl';
import { formatDate, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { ratioOrDash } from './labels';
import { PanelHeader, TableShell, rowClass } from './TableShell';

const BENCHMARK_OPTIONS = BENCHMARK_SYMBOLS.map((s) => ({ value: s, label: s }));

const drawdownText = (d: AnalyticsRiskResponse['maxDrawdown']): string => (d ? formatPercent(d.depthPct) : '—');

function drawdownDetail(d: AnalyticsRiskResponse['maxDrawdown']): string {
  if (!d || d.peakDate === null || d.troughDate === null) return 'No decline since you started.';
  const recovery = d.recoveryDate ? `recovered ${formatDate(d.recoveryDate)}` : 'not yet recovered';
  return `Peak ${formatDate(d.peakDate)}, low ${formatDate(d.troughDate)}, ${recovery}.`;
}

function RiskContent({ data }: Readonly<{ data: AnalyticsRiskResponse }>) {
  const enough = data.observations >= MIN_RISK_OBSERVATIONS;
  const rows: { metric: string; value: string; note: string }[] = [
    { metric: 'Volatility (annualised)', value: data.volatilityPct === null ? '—' : formatPercent(data.volatilityPct), note: 'How much daily returns fluctuate, scaled to a year.' },
    { metric: 'Sharpe ratio', value: ratioOrDash(data.sharpe), note: `Return above the ${formatPercent(data.riskFreeRatePct, { digits: 1 })} risk-free rate per unit of volatility.` },
    { metric: 'Sortino ratio', value: ratioOrDash(data.sortino), note: 'Like Sharpe, but only downside volatility counts as risk.' },
    { metric: 'Maximum drawdown', value: drawdownText(data.maxDrawdown), note: drawdownDetail(data.maxDrawdown) },
    { metric: `Beta vs ${data.benchmark.symbol}`, value: ratioOrDash(data.benchmark.beta), note: 'Below 1: moves less than the benchmark; above 1: more.' },
    { metric: `Correlation with ${data.benchmark.symbol}`, value: ratioOrDash(data.benchmark.correlation), note: 'Between −1 and 1: how closely the two move together.' },
  ];
  return (
    <div className="space-y-4">
      {!enough && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          Risk figures need at least {MIN_RISK_OBSERVATIONS} trading days of history; you have {data.observations}.
        </p>
      )}
      {data.benchmark.message && (
        <p role="status" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
          {data.benchmark.message}
        </p>
      )}
      <TableShell caption="Risk metrics" columns={[{ label: 'Metric' }, { label: 'Value', align: 'right' }, { label: 'What it means' }]}>
        {rows.map((r) => (
          <tr key={r.metric} className={rowClass}>
            <th scope="row" className="py-2.5 pr-3 text-left font-medium whitespace-nowrap">
              {r.metric}
            </th>
            <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">{r.value}</td>
            <td className="muted py-2.5 text-xs">{r.note}</td>
          </tr>
        ))}
      </TableShell>
      <p className="muted text-xs">
        {data.from && data.to
          ? `Based on ${data.observations} weekday returns from ${formatDate(data.from)} to ${formatDate(data.to)}, corrected for deposits and withdrawals. `
          : ''}
        Past volatility does not predict future results.
      </p>
    </div>
  );
}

export function RiskTab() {
  const [benchmark, setBenchmark] = useState<string>(BENCHMARK_SYMBOLS[0]);
  const { scope, ready } = usePortfolioScope();
  const query = useAnalyticsRisk(scope, benchmark, { enabled: ready });
  return (
    <section aria-labelledby="risk-title">
      <PanelHeader
        id="risk-title"
        title="Risk metrics"
        controls={
          <>
            <span className="muted text-xs">Benchmark</span>
            <SegmentedControl label="Risk benchmark" options={BENCHMARK_OPTIONS} value={benchmark} onChange={setBenchmark} />
          </>
        }
      />
      <QueryBoundary query={query} loadingLabel="Loading risk metrics" errorTitle="Could not load risk metrics" skeletonClassName="h-64 w-full">
        {(data) => <RiskContent data={data} />}
      </QueryBoundary>
    </section>
  );
}
