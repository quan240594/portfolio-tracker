import { PE_GAUGE_SCALE, daysBetween, type AnalyticsMetricsResponse, type PeExclusion } from '@portfolio/shared';
import { formatDate } from '../../lib/format';
import { Gauge, type GaugeMarker } from './Gauge';
import { MetricCard } from './MetricCard';
import { formatMultiple, formatMultipleTick, formatShare } from './format';

type Pe = AnalyticsMetricsResponse['pe'];

/** Earnings data older than this is flagged; it is refreshed whenever the instrument is next enriched. */
const STALE_AFTER_DAYS = 90;
const TICKS = [0, 10, 20, 30, 40, 50, 60, 70];

const REASON_TEXT: Record<PeExclusion['reason'], string> = {
  missing: 'no earnings data',
  'non-positive': 'no positive earnings',
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function CoverageLine({ pe }: Readonly<{ pe: Pe }>) {
  const c = pe.coverage;
  const stockShare = c.includedStocks > 0 ? `; the stocks you hold are covered for ${formatShare(c.stockSharePct)} of their value` : '';
  return (
    <div className="space-y-1">
      <p className="text-sm" data-testid="pe-coverage">
        Based on {c.includedStocks} of {c.totalStocks} {plural(c.totalStocks, 'stock', 'stocks')}, {formatShare(c.portfolioSharePct)} of portfolio value.
      </p>
      {c.nonStockHoldings > 0 && (
        <p className="muted text-xs">
          ETFs, crypto and other holdings are not part of a P/E{stockShare}.
        </p>
      )}
    </div>
  );
}

function ExcludedList({ excluded }: Readonly<{ excluded: readonly PeExclusion[] }>) {
  if (excluded.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium select-none">
        {excluded.length} {plural(excluded.length, 'stock', 'stocks')} left out
      </summary>
      <ul className="muted mt-1.5 list-inside list-disc text-xs">
        {excluded.map((e) => (
          <li key={e.symbol}>
            {e.symbol} ({e.name}): {REASON_TEXT[e.reason]}
          </li>
        ))}
      </ul>
    </details>
  );
}

function EmptyPe({ pe }: Readonly<{ pe: Pe }>) {
  const noStocks = pe.coverage.totalStocks === 0;
  return (
    <div className="space-y-3">
      <p className="text-4xl font-semibold tracking-tight">—</p>
      <div className="rounded-xl border border-dashed border-slate-300 p-4 text-sm dark:border-slate-700" data-testid="pe-empty">
        {noStocks ? (
          <p>
            <strong>No individual stocks.</strong> A price/earnings ratio only exists for companies, so ETFs, crypto and other assets are left out. Add stocks to see your P/E.
          </p>
        ) : (
          <p>
            <strong>Earnings data is missing.</strong> None of your stocks has a usable trailing P/E yet. The ratio comes from the market-data provider&apos;s company overview, which
            is fetched once when a stock is first added; companies without positive earnings have none at all. Stocks added before this metric existed pick it up the next time
            their data is refreshed.
          </p>
        )}
      </div>
      <CoverageLine pe={pe} />
      <ExcludedList excluded={pe.excluded} />
    </div>
  );
}

function PeInfo() {
  return (
    <>
      <p>
        Portfolio P/E is the <strong>weighted harmonic mean</strong> of the stocks&apos; trailing-twelve-month P/E ratios: the total value of the covered stocks divided by the
        total earnings they represent, Σ value ÷ Σ (value ÷ P/E). That equals one divided by the value-weighted earnings yield. A plain average would overstate it: two equal
        holdings with P/E 10 and 40 give 16, not 25.
      </p>
      <p>
        Only individual stocks count. ETFs, crypto, bonds, funds, custom assets and cash are excluded, as are stocks whose P/E is missing or not positive. The coverage line
        always says how much of your portfolio the figure rests on (portfolio value here means your invested holdings: cash balances and custom assets are not included). The market marker is the benchmark&apos;s own P/E and only appears when its data has one (ETFs usually do not).
      </p>
    </>
  );
}

const multipleOrBlank = (v: number | null) => (v === null ? '' : formatMultiple(v));

/** Card 2: portfolio P/E with its coverage, on a 0×–70× scale. */
export function PeCard({ data }: Readonly<{ data: AnalyticsMetricsResponse }>) {
  const { pe, benchmark, twr } = data;
  const value = pe.portfolio;
  const stale = pe.asOf !== null && daysBetween(pe.asOf, twr.to) > STALE_AFTER_DAYS;
  const staleNote = stale ? ` That is more than ${STALE_AFTER_DAYS} days ago; it is refreshed when the instrument is next enriched.` : '';
  const markers: GaugeMarker[] = [
    { key: 'portfolio', label: 'Portfolio', value, text: multipleOrBlank(value) },
    { key: 'benchmark', label: 'Market', value: pe.benchmark, text: multipleOrBlank(pe.benchmark) },
  ];
  return (
    <MetricCard name="pe" title="Portfolio P/E" info={<PeInfo />}>
      {value === null ? (
        <EmptyPe pe={pe} />
      ) : (
        <>
          <p className="text-4xl font-semibold tracking-tight tabular-nums" data-testid="pe-value">
            {formatMultiple(value)}
          </p>
          <p className="muted text-sm">Weighted average price/earnings ratio of your individual stocks (trailing twelve months).</p>
          <Gauge label="Price/earnings ratio" scale={PE_GAUGE_SCALE} markers={markers} ticks={TICKS} formatTick={formatMultipleTick} endLabels={['Cheaper', 'More expensive']} />
          {pe.benchmark === null && <p className="muted text-xs">{benchmark.symbol} has no P/E of its own, so there is no market marker.</p>}
          <CoverageLine pe={pe} />
          <ExcludedList excluded={pe.excluded} />
          {pe.asOf && (
            <p className="muted text-xs">
              Earnings data as of {formatDate(pe.asOf)}.{staleNote}
            </p>
          )}
        </>
      )}
    </MetricCard>
  );
}
