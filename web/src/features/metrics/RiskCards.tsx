import {
  MIN_RISK_OBSERVATIONS,
  SHARPE_BANDS,
  SHARPE_GAUGE_SCALE,
  SHORT_HISTORY_OBSERVATIONS,
  SORTINO_BANDS,
  SORTINO_GAUGE_SCALE,
  volatilityScale,
  type AnalyticsMetricsResponse,
  type GaugeScale,
  type Verdict,
} from '@portfolio/shared';
import type { ReactNode } from 'react';
import { formatPercent } from '../../lib/format';
import { Gauge, type GaugeBand, type GaugeMarker } from './Gauge';
import { HistoryNotice, MetricCard, VerdictChip } from './MetricCard';
import { formatRatio, formatRatioTick, formatVolatility, formatVolatilityTick } from './format';

type Data = Readonly<{ data: AnalyticsMetricsResponse }>;

const orBlank = (v: number | null, format: (n: number) => string) => (v === null ? '' : format(v));

function markers(portfolio: number | null, benchmark: number | null, format: (n: number) => string): GaugeMarker[] {
  return [
    { key: 'portfolio', label: 'Portfolio', value: portfolio, text: orBlank(portfolio, format) },
    { key: 'benchmark', label: 'Market', value: benchmark, text: orBlank(benchmark, format) },
  ];
}

function VerdictSuffix({ verdict }: Readonly<{ verdict: Verdict | null }>) {
  if (!verdict) return null;
  return (
    <>
      {' — '}
      <VerdictChip tone={verdict.tone}>{verdict.label}</VerdictChip>
    </>
  );
}

function MarketNote({ data, value }: Readonly<{ data: AnalyticsMetricsResponse; value: number | null }>) {
  if (value !== null) return <p className="muted text-xs">Market = {data.benchmark.symbol}, calculated the same way over the same period.</p>;
  const why = data.benchmark.available ? 'there is not enough overlapping history' : `${data.benchmark.symbol} has no price data`;
  return <p className="muted text-xs">No market marker: {why}.</p>;
}

interface RiskCardProps {
  name: string;
  title: string;
  headline: ReactNode;
  observations: number;
  info: ReactNode;
  children?: ReactNode;
}

function RiskCard({ name, title, headline, observations, info, children }: Readonly<RiskCardProps>) {
  return (
    <MetricCard name={name} title={title} info={info}>
      <p className="text-lg leading-snug font-semibold">{headline}</p>
      <HistoryNotice observations={observations} minimum={MIN_RISK_OBSERVATIONS} shortBelow={SHORT_HISTORY_OBSERVATIONS} />
      {children}
    </MetricCard>
  );
}

const ratioTicks = (scale: GaugeScale) => Array.from({ length: scale.max - scale.min + 1 }, (_, i) => scale.min + i);

// --- Volatility / beta ---------------------------------------------------------------------------

function VolatilityInfo() {
  return (
    <>
      <p>
        Volatility is the annualised standard deviation of your weekday returns (daily standard deviation × √252). Beta is the covariance of your returns with the benchmark&apos;s
        divided by the benchmark&apos;s variance: how strongly your portfolio moves with the market.
      </p>
      <p>
        The verdict follows beta: below 0,9 lower than the market, 0,9 to 1,1 in line with the market, above 1,1 higher than the market. The gauge shows annualised volatility for
        you and for the benchmark, both computed from their own end-of-day returns over the same period, so the two are comparable.
      </p>
      <p>Needs at least 20 trading days; below about 60 the figures are shown with a warning. Past volatility does not predict future results.</p>
    </>
  );
}

/** Card 3: volatility verdict from beta, gauge of annualised volatility for portfolio and market. */
export function VolatilityCard({ data }: Data) {
  const v = data.volatility;
  const scale = volatilityScale([v.portfolio, v.benchmark]);
  const step = scale.max <= 80 ? 10 : 20;
  const ticks = [...new Set([...Array.from({ length: Math.floor(scale.max / step) + 1 }, (_, i) => i * step), scale.max])];
  const headline =
    v.beta === null ? (
      'Volatility of your portfolio'
    ) : (
      <>
        Volatility of your portfolio (β = <span className="tabular-nums">{formatRatio(v.beta)}</span>)
        <VerdictSuffix verdict={v.verdict} />
      </>
    );
  return (
    <RiskCard name="volatility" title="Volatility / beta" headline={headline} observations={v.observations} info={<VolatilityInfo />}>
      {v.portfolio !== null && (
        <>
          <Gauge
            label="Annualised volatility"
            scale={scale}
            markers={markers(v.portfolio, v.benchmark, formatVolatility)}
            ticks={ticks}
            formatTick={formatVolatilityTick}
            verdict={v.verdict ? `Verdict: ${v.verdict.label}.` : undefined}
            endLabels={['Low volatility', 'High volatility']}
          />
          <MarketNote data={data} value={v.benchmark} />
          {v.beta === null && <p className="muted text-xs">Beta, and so the verdict, needs {data.benchmark.symbol} price data over the same period.</p>}
        </>
      )}
    </RiskCard>
  );
}

// --- Sharpe and Sortino --------------------------------------------------------------------------

function SharpeInfo({ riskFreeRatePct }: Readonly<{ riskFreeRatePct: number }>) {
  return (
    <>
      <p>
        Sharpe ratio = (mean daily return − daily risk-free rate) ÷ standard deviation of daily returns × √252: the return above the risk-free rate you earned per unit of
        volatility. Inputs are your weekday returns with deposits and withdrawals removed (dividends count as return) and a constant risk-free rate of{' '}
        {formatPercent(riskFreeRatePct, { digits: 1 })} a year.
      </p>
      <p>
        Bands: below 0 poor, 0 up to 1 requires attention, 1 to 2 good, above 2 very good. The market marker applies the same formula to the benchmark&apos;s own price returns over
        the same period. Needs at least 20 trading days, below about 60 the figure is shown with a warning.
      </p>
    </>
  );
}

function SortinoInfo({ riskFreeRatePct }: Readonly<{ riskFreeRatePct: number }>) {
  return (
    <>
      <p>
        Sortino ratio = (mean daily return − daily risk-free rate) ÷ downside deviation × √252. Like Sharpe, but only days below the risk-free rate count as risk, so large gains
        are not punished. Inputs are your weekday returns with deposits and withdrawals removed and a constant risk-free rate of {formatPercent(riskFreeRatePct, { digits: 1 })} a year.
      </p>
      <p>
        Bands: below 0 poor, 0 up to 1 requires attention, 1 to 2 acceptable, above 2 good (over two is considered to be good). The market marker applies the same formula to the
        benchmark&apos;s own price returns over the same period. Needs at least 20 trading days, below about 60 the figure is shown with a warning.
      </p>
    </>
  );
}

const SHARPE_BAND_LIST: GaugeBand[] = [
  { from: SHARPE_GAUGE_SCALE.min, to: SHARPE_BANDS.attentionFrom, tone: 'negative' },
  { from: SHARPE_BANDS.attentionFrom, to: SHARPE_BANDS.goodFrom, tone: 'caution' },
  { from: SHARPE_BANDS.goodFrom, to: SHARPE_BANDS.veryGoodAbove, tone: 'positive' },
  { from: SHARPE_BANDS.veryGoodAbove, to: SHARPE_GAUGE_SCALE.max, tone: 'positive' },
];
const SORTINO_BAND_LIST: GaugeBand[] = [
  { from: SORTINO_GAUGE_SCALE.min, to: SORTINO_BANDS.attentionFrom, tone: 'negative' },
  { from: SORTINO_BANDS.attentionFrom, to: SORTINO_BANDS.acceptableFrom, tone: 'caution' },
  { from: SORTINO_BANDS.acceptableFrom, to: SORTINO_BANDS.goodAbove, tone: 'neutral' },
  { from: SORTINO_BANDS.goodAbove, to: SORTINO_GAUGE_SCALE.max, tone: 'positive' },
];

interface RatioProps {
  data: AnalyticsMetricsResponse;
  name: string;
  title: string;
  label: string;
  metric: { portfolio: number | null; benchmark: number | null; observations: number; verdict: Verdict | null };
  scale: GaugeScale;
  bands: readonly GaugeBand[];
  info: ReactNode;
}

function RatioCard({ data, name, title, label, metric, scale, bands, info }: Readonly<RatioProps>) {
  const { portfolio, benchmark, verdict } = metric;
  const headline = (
    <>
      {label} = <span className="tabular-nums">{portfolio === null ? '—' : formatRatio(portfolio)}</span>
      <VerdictSuffix verdict={verdict} />
    </>
  );
  return (
    <RiskCard name={name} title={title} headline={headline} observations={metric.observations} info={info}>
      {portfolio !== null && (
        <>
          <Gauge
            label={label}
            scale={scale}
            markers={markers(portfolio, benchmark, formatRatio)}
            bands={bands}
            ticks={ratioTicks(scale)}
            formatTick={formatRatioTick}
            verdict={verdict ? `Verdict: ${verdict.label}.` : undefined}
            endLabels={['Worse risk-adjusted return', 'Better']}
          />
          <MarketNote data={data} value={benchmark} />
        </>
      )}
    </RiskCard>
  );
}

/** Card 4: risk-adjusted return, Sharpe ratio. */
export function SharpeCard({ data }: Data) {
  return (
    <RatioCard
      data={data}
      name="sharpe"
      title="Risk-adjusted return / Sharpe ratio"
      label="Sharpe ratio"
      metric={data.sharpe}
      scale={SHARPE_GAUGE_SCALE}
      bands={SHARPE_BAND_LIST}
      info={<SharpeInfo riskFreeRatePct={data.riskFreeRatePct} />}
    />
  );
}

/** Card 5: risk-adjusted return, Sortino ratio. */
export function SortinoCard({ data }: Data) {
  return (
    <RatioCard
      data={data}
      name="sortino"
      title="Risk-adjusted return / Sortino ratio"
      label="Sortino ratio"
      metric={data.sortino}
      scale={SORTINO_GAUGE_SCALE}
      bands={SORTINO_BAND_LIST}
      info={<SortinoInfo riskFreeRatePct={data.riskFreeRatePct} />}
    />
  );
}
