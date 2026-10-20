import { Link } from 'react-router-dom';
import { isQuoteStale, type AssetDetailResponse } from '@portfolio/shared';
import { useWatchlist, useWatchlistMutations } from '../../api/management-hooks';
import { Change } from '../../components/Change';
import { formatDate, formatMoney, formatPercent } from '../../lib/format';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { DASH, formatBigMoney, formatRatio, initialsOf, monogramClass } from './assetFormat';
import { Figure } from './StatsSidebar';

function Monogram({ name, symbol }: Readonly<{ name: string; symbol: string }>) {
  return (
    <span aria-hidden="true" className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-lg font-bold ${monogramClass(symbol)}`}>
      {initialsOf(name, symbol)}
    </span>
  );
}

function Breadcrumb({ detail }: Readonly<{ detail: AssetDetailResponse }>) {
  const { withScope } = usePortfolioScope();
  const { profile } = detail;
  const trail = [profile.country, profile.sector].filter((v): v is string => v !== null);
  return (
    <nav aria-label="Breadcrumb" className="muted mb-3 text-sm">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <li>
          <Link to={withScope('/assets')} className="underline-offset-2 hover:underline">
            Securities
          </Link>
        </li>
        {trail.map((part) => (
          <li key={part} className="flex items-center gap-2">
            <span aria-hidden="true">·</span>
            <span>{part}</span>
          </li>
        ))}
        <li className="flex items-center gap-2">
          <span aria-hidden="true">·</span>
          <span aria-current="page" className="font-medium text-slate-700 dark:text-slate-200">
            {profile.symbol}
          </span>
        </li>
      </ol>
    </nav>
  );
}

function WatchlistStar({ symbol }: Readonly<{ symbol: string }>) {
  const watchlist = useWatchlist();
  const { add, remove } = useWatchlistMutations();
  const watching = watchlist.data?.items.some((i) => i.symbol === symbol) ?? false;
  const busy = add.isPending || remove.isPending;
  const toggle = () => (watching ? remove.mutate(symbol) : add.mutate(symbol));
  return (
    <button type="button" className="btn-secondary" aria-pressed={watching} disabled={busy || watchlist.isPending} onClick={toggle}>
      <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-4 w-4 ${watching ? 'fill-amber-400 stroke-amber-500' : 'fill-none stroke-current'}`} strokeWidth="1.8" strokeLinejoin="round">
        <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8 6.8 19.6l1-5.8L3.5 9.7l5.9-.8L12 3.5z" />
      </svg>
      <span>{watching ? 'On your watchlist' : 'Add to watchlist'}</span>
    </button>
  );
}

/** Quote sources that are named next to the price, with the time of the quote (the others keep the plain date). */
const QUOTE_SOURCE_LABELS: Readonly<Record<string, string>> = { t212: 'Trading 212' };
const QUOTE_TIME_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };

function PriceBlock({ detail }: Readonly<{ detail: AssetDetailResponse }>) {
  const { quote, baseCurrency } = detail;
  if (!quote) return <p className="muted text-sm">No price available yet.</p>;
  const stale = isQuoteStale(quote.asOf, new Date().toISOString().slice(0, 10));
  const inBase = quote.currency !== baseCurrency && quote.priceBase !== null ? '≈ ' + formatMoney(quote.priceBase, baseCurrency) : null;
  const sourceLabel = quote.source === 'quote' && quote.provider !== undefined ? QUOTE_SOURCE_LABELS[quote.provider] : undefined;
  const asOf = (quote.source === 'quote' ? 'As of ' : 'Last close ') + formatDate(quote.asOf, sourceLabel === undefined ? undefined : QUOTE_TIME_FORMAT);
  return (
    <div>
      <p className="text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl" data-testid="asset-price">
        {formatMoney(quote.price, quote.currency, { maxDigits: quote.price < 1 ? 6 : 2 })}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Change amount={quote.change} pct={quote.changePct} currency={quote.currency} />
        <span className="muted">today</span>
      </p>
      <p className="muted mt-1 text-xs">
        {[inBase, asOf, sourceLabel ?? null].filter((part) => part !== null).join(' · ')}
        {stale && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">price may be outdated</span>}
      </p>
    </div>
  );
}

function KeyStat({ label, children }: Readonly<{ label: string; children: React.ReactNode | null }>) {
  return (
    <div className="min-w-0">
      <dt className="muted text-xs">{label}</dt>
      <dd className="mt-0.5 truncate text-base font-semibold tabular-nums">
        <Figure>{children}</Figure>
      </dd>
    </div>
  );
}

function KeyStats({ detail }: Readonly<{ detail: AssetDetailResponse }>) {
  const { stats, profile } = detail;
  return (
    <dl aria-label="Key statistics" className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
      <KeyStat label="Next earnings">{stats.nextEarningsDate === null ? null : formatDate(stats.nextEarningsDate)}</KeyStat>
      <KeyStat label="P/E">{stats.peRatio === null ? null : formatRatio(stats.peRatio, 1)}</KeyStat>
      <KeyStat label="EPS">{stats.eps === null ? null : formatMoney(stats.eps, profile.currency)}</KeyStat>
      <KeyStat label="Market cap">{stats.marketCap === null ? null : formatBigMoney(stats.marketCap, profile.currency)}</KeyStat>
      <KeyStat label="Dividend yield">{stats.dividendYieldPct === null ? null : formatPercent(stats.dividendYieldPct)}</KeyStat>
    </dl>
  );
}

/** Breadcrumb and header card: monogram, name, ticker, watchlist action, price with day change, key statistics. */
export function AssetHeader({ detail }: Readonly<{ detail: AssetDetailResponse }>) {
  const { profile } = detail;
  const meta = [profile.symbol, profile.exchange, profile.currency].filter((v): v is string => v !== null && v !== '');
  return (
    <>
      <Breadcrumb detail={detail} />
      <section aria-label={`${profile.name} overview`} className="card mb-5 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <Monogram name={profile.name} symbol={profile.symbol} />
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight break-words">{profile.name}</h1>
              <p className="muted text-sm">{meta.join(' · ') || DASH}</p>
            </div>
          </div>
          <WatchlistStar symbol={profile.symbol} />
        </div>
        <div className="mt-5 grid gap-5 border-t border-slate-100 pt-5 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] dark:border-slate-800">
          <PriceBlock detail={detail} />
          <KeyStats detail={detail} />
        </div>
      </section>
    </>
  );
}
