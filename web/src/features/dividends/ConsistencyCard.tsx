import {
  CONSISTENCY_CUT_PENALTY,
  CONSISTENCY_FULL_CV,
  CONSISTENCY_FULL_HISTORY_YEARS,
  CONSISTENCY_FULL_STREAK,
  CONSISTENCY_MIN_PAYMENTS,
  CONSISTENCY_NEUTRAL,
  CONSISTENCY_OK_FROM,
  CONSISTENCY_RELIABLE_FROM,
  CONSISTENCY_WEIGHTS,
  CONSISTENCY_ZERO_CV,
  type ConsistencyBadge,
  type ConsistencyScore,
  type DividendOverviewHolding,
  type DividendsOverviewResponse,
} from '@portfolio/shared';
import { formatMoney, formatPercent } from '../../lib/format';
import { ChartDataTable, Donut } from './chartParts';
import { EmptyNote, QueryCard } from './DividendCard';
import { useScopedDividendsOverview } from './useDividendsOverview';

interface BadgeStyle {
  label: string;
  /** Tailwind classes of the pill. */
  pill: string;
  /** Donut colour. */
  color: string;
}

const BADGES: Record<ConsistencyBadge, BadgeStyle> = {
  RELIABLE: { label: 'Reliable', pill: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200', color: '#10b981' },
  OK: { label: 'OK', pill: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200', color: '#f59e0b' },
  IRREGULAR: { label: 'Irregular', pill: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200', color: '#f43f5e' },
  NEW: { label: 'New', pill: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200', color: '#94a3b8' },
};
const BADGE_ORDER: readonly ConsistencyBadge[] = ['RELIABLE', 'OK', 'IRREGULAR', 'NEW'];

/** One-line breakdown of a score, e.g. "History 12/30 · Regularity 30/30 · Cuts 25/25 · Growth 3/15". */
export function scoreBreakdown(c: ConsistencyScore): string {
  const { points: p } = c;
  const w = CONSISTENCY_WEIGHTS;
  return `History ${p.history}/${w.history} · Regularity ${p.regularity}/${w.regularity} · Cuts ${p.cuts}/${w.cuts} · Growth ${p.growth}/${w.growth}`;
}

export function ConsistencyPill({ consistency }: Readonly<{ consistency: ConsistencyScore }>) {
  const badge = BADGES[consistency.badge];
  const detail = consistency.score === null ? 'Fewer than 2 known payments' : scoreBreakdown(consistency);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span title={detail} className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.pill}`}>
        {badge.label}
      </span>
      {consistency.score !== null && <span className="muted text-xs tabular-nums">{consistency.score}</span>}
    </span>
  );
}

function ScoreHelp() {
  const w = CONSISTENCY_WEIGHTS;
  return (
    <details className="mt-3 rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-800">
      <summary className="cursor-pointer font-medium select-none">How is the score calculated?</summary>
      <div className="mt-2 space-y-2 leading-relaxed">
        <p>
          The score (0-100) is computed only from your own data: the dividends you received and the dividend events stored for your holdings (about two years of history from the data provider). It adds up four parts:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>History ({w.history}):</strong> {w.history / CONSISTENCY_FULL_HISTORY_YEARS} points for each of the last {CONSISTENCY_FULL_HISTORY_YEARS} years (12-month periods back from today) with at least one payment.
          </li>
          <li>
            <strong>Regularity ({w.regularity}):</strong> how equal the gaps between payments are. Full points when the gaps vary by at most {CONSISTENCY_FULL_CV * 100}% (standard deviation ÷ mean), none at {CONSISTENCY_ZERO_CV * 100}% or more; a long wait since the last payment counts as one more gap. {CONSISTENCY_NEUTRAL.regularity} points with fewer than 3 payments.
          </li>
          <li>
            <strong>Cuts ({w.cuts}):</strong> {w.cuts} points minus {CONSISTENCY_CUT_PENALTY} for every year whose dividend per share was lower than the year before (changes within 0.5% count as flat). {CONSISTENCY_NEUTRAL.cuts} points without two full years of payments.
          </li>
          <li>
            <strong>Growth ({w.growth}):</strong> {w.growth / CONSISTENCY_FULL_STREAK} points for each consecutive year (newest first, up to {CONSISTENCY_FULL_STREAK}) in which the dividend per share went up.
          </li>
        </ul>
        <p>
          Badges: <strong>Reliable</strong> {CONSISTENCY_RELIABLE_FROM}+, <strong>OK</strong> {CONSISTENCY_OK_FROM}-{CONSISTENCY_RELIABLE_FROM - 1}, <strong>Irregular</strong> below {CONSISTENCY_OK_FROM}, <strong>New</strong> with fewer than {CONSISTENCY_MIN_PAYMENTS} known payments (no score). Hover a badge to see its points.
        </p>
        <p className="muted">Based on your payment history, not a forecast or advice. It says nothing about the company&apos;s finances.</p>
      </div>
    </details>
  );
}

function ConsistencyTable({ holdings, currency }: Readonly<{ holdings: readonly DividendOverviewHolding[]; currency: string }>) {
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Payment consistency per holding</caption>
        <thead>
          <tr className="muted sticky top-0 border-b border-slate-200 bg-white text-left text-xs dark:border-slate-800 dark:bg-slate-900">
            <th scope="col" className="py-2 pr-3 font-medium">Holding</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Income per year</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Yield</th>
            <th scope="col" className="py-2 font-medium">Consistency</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => (
            <tr key={h.symbol} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
              <th scope="row" className="py-2 pr-3 text-left font-normal">
                <span className="font-medium">{h.name}</span> <span className="muted text-xs">{h.symbol}</span>
              </th>
              <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(h.forward12m, currency)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatPercent(h.yieldPct)}</td>
              <td className="py-2">
                <ConsistencyPill consistency={h.consistency} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Consistency({ data }: Readonly<{ data: DividendsOverviewResponse }>) {
  const { holdings } = data;
  if (holdings.length === 0) return <EmptyNote>No dividend-paying holdings yet.</EmptyNote>;
  const counts = BADGE_ORDER.map((badge) => ({ badge, count: holdings.filter((h) => h.consistency.badge === badge).length })).filter((c) => c.count > 0);
  const slices = counts.map((c) => ({ key: c.badge, label: BADGES[c.badge].label, value: c.count, color: BADGES[c.badge].color }));
  const label = `Holdings by payment consistency: ${counts.map((c) => `${c.count} ${BADGES[c.badge].label}`).join(', ')}.`;
  return (
    <div className="space-y-4">
      <p className="muted text-xs">Based on your payment history, not a forecast or advice.</p>
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div>
          <Donut slices={slices} label={label} testId="consistency-donut" format={(v) => `${v} holding${v === 1 ? '' : 's'}`} />
          <ul className="mt-3 space-y-1 text-sm" aria-label="Holdings per badge">
            {counts.map((c) => (
              <li key={c.badge} className="flex items-center gap-2">
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ background: BADGES[c.badge].color }} />
                <span>{BADGES[c.badge].label}</span>
                <span className="ml-auto font-medium tabular-nums">{c.count}</span>
              </li>
            ))}
          </ul>
        </div>
        <ConsistencyTable holdings={holdings} currency={data.baseCurrency} />
      </div>
      <ScoreHelp />
      <ChartDataTable caption="Consistency badge counts" columns={['Badge', 'Holdings']} rows={counts.map((c) => [BADGES[c.badge].label, c.count])} />
    </div>
  );
}

export function ConsistencyCard() {
  const query = useScopedDividendsOverview();
  return (
    <QueryCard
      id="div-consistency"
      title="Payment consistency"
      query={query}
      loadingLabel="Loading payment consistency"
      errorTitle="Could not load payment consistency"
      skeletonClassName="h-64 w-full"
      info={
        <>
          <p>A transparent 0-100 score of how steadily each holding has paid: years with payments, regularity of the payment schedule, dividend cuts and a growth streak.</p>
          <p>It uses only your payment history and stored dividend events (the provider covers about two years), not company fundamentals. It is not a forecast or advice.</p>
        </>
      }
    >
      {(data) => <Consistency data={data} />}
    </QueryCard>
  );
}
