import type { DividendOverviewSummary } from '@portfolio/shared';
import { Change } from '../../components/Change';
import { ErrorState } from '../../components/ErrorState';
import { KpiCard } from '../../components/KpiCard';
import { formatMoney, formatPercent } from '../../lib/format';
import { TTM_NOTE } from '../dashboard/dashboardPeriod';
import { useScopedDividendsOverview } from './useDividendsOverview';

const YIELD_INFO = (
  <>
    <p>TTM means trailing twelve months: the net dividends you actually received in the last 12 months (after withholding tax, in your base currency), divided by the current market value of your holdings.</p>
    <p>On cost divides the same amount by what you paid for your holdings. A holding you bought recently has not had a full year to pay yet, so it pulls the trailing yield down.</p>
    <p>This looks back at what was received. The Passive income (next 12 months) card looks ahead at what is declared or estimated, so the two differ.</p>
  </>
);

const GROWTH_INFO = (
  <>
    <p>TTM means trailing twelve months: the net dividends you received in the last 12 months compared with the 12 months before that.</p>
    <p>It shows n/a when nothing was received in that earlier period, because there is nothing to compare with. When your first dividend arrived inside it, that period is only partly covered and the growth can look high.</p>
    <p>This compares two periods that already happened. The forward figure on the Dividends page compares expected income with what you received.</p>
  </>
);

function yieldHint(s: DividendOverviewSummary): string {
  if (s.last12m <= 0) return 'No dividends received in the last 12 months';
  return `Trailing 12 months, ${s.ttmPayers} dividend-paying holding${s.ttmPayers === 1 ? '' : 's'}`;
}

/** Why there is no trailing growth figure. */
function growthMissing(s: DividendOverviewSummary): string {
  if (s.last12m <= 0) return 'No dividends received in the last 24 months';
  return 'No dividends received in the previous 12 months to compare with';
}

function growthHint(s: DividendOverviewSummary): string {
  if (s.ttmGrowthPct === null) return growthMissing(s);
  const base = 'Net received, last 12 months vs the 12 months before';
  return s.previous12mPartial ? `${base} · your first dividend came during that earlier period, so it is only partly covered` : base;
}

interface Props {
  currency: string;
  summary: DividendOverviewSummary;
}

function YieldCard({ currency, summary }: Readonly<Props>) {
  return (
    <KpiCard
      label="Dividend yield (TTM)"
      note={TTM_NOTE}
      info={YIELD_INFO}
      value={formatPercent(summary.ttmYieldOnValuePct)}
      change={
        <span className="muted">
          {formatPercent(summary.ttmYieldOnCostPct)} on cost · {formatMoney(summary.last12m, currency)} received
        </span>
      }
      hint={yieldHint(summary)}
    />
  );
}

function GrowthCard({ currency, summary }: Readonly<Props>) {
  const { ttmGrowthPct } = summary;
  return (
    <KpiCard
      label="Dividend growth (TTM)"
      note={TTM_NOTE}
      info={GROWTH_INFO}
      value={ttmGrowthPct === null ? 'n/a' : <Change pct={ttmGrowthPct} digits={1} />}
      change={
        ttmGrowthPct !== null && (
          <span className="muted">
            {formatMoney(summary.last12m, currency)} vs {formatMoney(summary.previous12m, currency)}
          </span>
        )
      }
      hint={growthHint(summary)}
    />
  );
}

/** Trailing-twelve-month dividend yield and growth, from GET /dividends/overview (the same request the Dividends page uses). */
export function TrailingDividendKpis() {
  const { data, isPending, isError, error, refetch } = useScopedDividendsOverview();
  if (isError) {
    return (
      <div className="sm:col-span-2 lg:col-span-2">
        <ErrorState error={error} onRetry={() => void refetch()} title="Could not load trailing dividends" className="h-full" />
      </div>
    );
  }
  if (isPending || !data) {
    return (
      <>
        <KpiCard loading label="Dividend yield (TTM)" note={TTM_NOTE} info={YIELD_INFO} value={null} />
        <KpiCard loading label="Dividend growth (TTM)" note={TTM_NOTE} info={GROWTH_INFO} value={null} />
      </>
    );
  }
  return (
    <>
      <YieldCard currency={data.baseCurrency} summary={data.summary} />
      <GrowthCard currency={data.baseCurrency} summary={data.summary} />
    </>
  );
}
