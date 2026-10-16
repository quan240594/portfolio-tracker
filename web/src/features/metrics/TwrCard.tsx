import { DAYS_PER_YEAR, type AnalyticsMetricsResponse } from '@portfolio/shared';
import { trendOf, formatDate } from '../../lib/format';
import { Chip, MetricCard, Notice } from './MetricCard';
import { formatPoints, formatReturn } from './format';

const ARROW = { up: '▲', down: '▼', flat: '■' } as const;
const SR_WORD = { up: 'ahead of', down: 'behind', flat: 'level with' } as const;
const TREND_CLASS = { up: 'gain-text', down: 'loss-text', flat: 'muted' } as const;

function BenchmarkChip({ twr, symbol }: Readonly<{ twr: AnalyticsMetricsResponse['twr']; symbol: string }>) {
  if (twr.benchmark === null || twr.difference === null) {
    return <p className="muted text-sm">No {symbol} comparison available for this period.</p>;
  }
  const trend = trendOf(twr.difference);
  const since = twr.benchmarkFrom !== null && twr.from !== null && twr.benchmarkFrom > twr.from ? twr.benchmarkFrom : null;
  return (
    <div className="space-y-1.5">
      <Chip>
        <span>
          {symbol}: <span className="tabular-nums">{formatReturn(twr.benchmark)}</span>
        </span>
        <span className={`tabular-nums ${TREND_CLASS[trend]}`}>
          (<span aria-hidden="true">{ARROW[trend]} </span>
          {formatPoints(twr.difference)})
        </span>
      </Chip>
      <p className="muted text-xs">
        You are {formatPoints(twr.difference)} {SR_WORD[trend]} {symbol} over the same period.
        {since && ` ${symbol} price history only starts on ${formatDate(since)}, so the comparison runs from then.`}
      </p>
    </div>
  );
}

function Bar({ label, value, max, testId }: Readonly<{ label: string; value: number; max: number; testId: string }>) {
  const color = value < 0 ? 'bg-red-400 dark:bg-red-500/70' : 'bg-brand-500 dark:bg-brand-400';
  return (
    <div className="grid grid-cols-[5.5rem_1fr_4.5rem] items-center gap-2 text-xs">
      <span className="muted break-words">{label}</span>
      <span className="h-2.5 rounded-full bg-slate-100 dark:bg-slate-800">
        <span className={`block h-full rounded-full ${color}`} style={{ width: `${((Math.abs(value) / max) * 100).toFixed(1)}%` }} data-testid={testId} />
      </span>
      <span className="text-right font-medium tabular-nums">{formatReturn(value)}</span>
    </div>
  );
}

/** Portfolio and benchmark return side by side; the text values above carry the same information. */
function ReturnBars({ portfolio, benchmark, symbol }: Readonly<{ portfolio: number; benchmark: number; symbol: string }>) {
  const max = Math.max(Math.abs(portfolio), Math.abs(benchmark), 1);
  return (
    <div className="space-y-1.5" aria-hidden="true">
      <Bar label="Portfolio" value={portfolio} max={max} testId="twr-bar-portfolio" />
      <Bar label={symbol} value={benchmark} max={max} testId="twr-bar-benchmark" />
    </div>
  );
}

function TwrInfo({ data }: Readonly<{ data: AnalyticsMetricsResponse }>) {
  return (
    <>
      <p>
        Time-weighted return (TWR) chains the return of every day: ∏ (1 + daily return) − 1. A daily return is the change in
        value of your holdings after removing that day&apos;s buys and sells, with dividends counted as return. Because each day is
        measured on its own, the timing and size of your deposits do not influence the result.
      </p>
      <p>
        Window: from your first investment transaction to today, so the whole lifetime of the {data.baseCurrency} portfolio in this scope. Cash deposits,
        withdrawals, fees, interest and splits are not investment flows. The benchmark figure is the price return of the benchmark
        over the same period (price only, no dividends), converted to euro like your holdings.
      </p>
    </>
  );
}

function TwrBody({ data, value }: Readonly<{ data: AnalyticsMetricsResponse; value: number }>) {
  const { twr, benchmark } = data;
  return (
    <>
      <p className={`text-4xl font-semibold tracking-tight tabular-nums ${TREND_CLASS[trendOf(value)]}`} data-testid="twr-value">
        {formatReturn(value)}
      </p>
      <p className="muted text-sm">
        Time-weighted return since {formatDate(twr.from ?? twr.to)} ({twr.days} days). It leaves out the effect of when you added or withdrew money, so it measures how
        your investments performed.
      </p>
      {benchmark.available ? <BenchmarkChip twr={twr} symbol={benchmark.symbol} /> : <p className="muted text-sm">Benchmark comparison unavailable.</p>}
      {twr.benchmark !== null && <ReturnBars portfolio={value} benchmark={twr.benchmark} symbol={benchmark.symbol} />}
      {twr.days < DAYS_PER_YEAR && <p className="muted text-xs">Less than a year of history: the return is not annualised.</p>}
    </>
  );
}

/** Card 1: lifetime time-weighted return next to the benchmark over the same period. */
export function TwrCard({ data }: Readonly<{ data: AnalyticsMetricsResponse }>) {
  const value = data.twr.portfolio;
  return (
    <MetricCard name="twr" title="Portfolio TWR" info={<TwrInfo data={data} />}>
      {value === null ? (
        <>
          <p className="text-4xl font-semibold tracking-tight">—</p>
          <Notice>Not enough history yet: a time-weighted return needs at least two days with holdings.</Notice>
        </>
      ) : (
        <TwrBody data={data} value={value} />
      )}
    </MetricCard>
  );
}
