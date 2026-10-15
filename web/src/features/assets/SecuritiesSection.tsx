import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useClosedSecurities } from '../../api/assetHooks';
import { useHoldings } from '../../api/hooks';
import { Change } from '../../components/Change';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { formatMoney, formatQuantity, formatWeight } from '../../lib/format';
import { assetPath } from '../asset-detail/assetFormat';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { buildSecurityRows, filterSecurities, sortSecurities, type SecurityRow, type SecuritySortKey, type SortDir } from './securities';

interface SortState {
  key: SecuritySortKey;
  dir: SortDir;
}

interface Column {
  key: SecuritySortKey;
  label: string;
  align: 'left' | 'right';
}

const COLUMNS: Column[] = [
  { key: 'symbol', label: 'Security', align: 'left' },
  { key: 'sector', label: 'Sector', align: 'left' },
  { key: 'country', label: 'Country', align: 'left' },
  { key: 'currency', label: 'Currency', align: 'left' },
  { key: 'quantity', label: 'Shares', align: 'right' },
  { key: 'marketValue', label: 'Value (EUR)', align: 'right' },
  { key: 'pnlPct', label: 'P/L %', align: 'right' },
  { key: 'weight', label: 'Weight', align: 'right' },
];

const sortLabel = (dir: SortDir) => (dir === 'asc' ? 'ascending' : 'descending');
const sortArrow = (active: boolean, dir: SortDir) => {
  if (!active) return '▲▼';
  return dir === 'asc' ? '▲' : '▼';
};
const defaultDir = (key: SecuritySortKey): SortDir => (['symbol', 'sector', 'country', 'currency'].includes(key) ? 'asc' : 'desc');

function SoldBadge() {
  return <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.7rem] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">Sold out</span>;
}

function SecurityLink({ row, to }: Readonly<{ row: SecurityRow; to: string }>) {
  return (
    <Link to={to} className="font-semibold underline-offset-2 hover:underline">
      {row.symbol}
    </Link>
  );
}

function SortableHeader({ col, sort, onSort }: Readonly<{ col: Column; sort: SortState; onSort: (key: SecuritySortKey) => void }>) {
  const active = sort.key === col.key;
  return (
    <th scope="col" aria-sort={active ? sortLabel(sort.dir) : 'none'} className={`px-3 py-2.5 font-medium whitespace-nowrap ${col.align === 'right' ? 'text-right' : 'text-left'}`}>
      <button type="button" onClick={() => onSort(col.key)} className={`inline-flex items-center gap-1 rounded hover:text-slate-900 dark:hover:text-white ${active ? 'text-slate-900 dark:text-white' : 'muted'}`}>
        {col.label}
        <span aria-hidden="true" className={`text-[10px] ${active ? '' : 'opacity-30'}`}>
          {sortArrow(active, sort.dir)}
        </span>
      </button>
    </th>
  );
}

function SecurityTableRow({ row, to }: Readonly<{ row: SecurityRow; to: string }>) {
  const dash = row.sold ? '—' : null;
  return (
    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40">
      <th scope="row" className="px-3 py-2.5 text-left font-normal">
        <div className="flex items-center gap-2">
          <SecurityLink row={row} to={to} />
          {row.sold && <SoldBadge />}
        </div>
        <div className="muted max-w-[14rem] truncate text-xs">{row.name}</div>
      </th>
      <td className="px-3 py-2.5">{row.sector}</td>
      <td className="px-3 py-2.5">{row.country}</td>
      <td className="px-3 py-2.5">{row.currency}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{dash ?? formatQuantity(row.quantity)}</td>
      <td className="px-3 py-2.5 text-right font-medium tabular-nums">{dash ?? formatMoney(row.marketValue)}</td>
      <td className="px-3 py-2.5 text-right">
        <Change pct={row.pnlPct} value={row.pnl} />
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{dash ?? formatWeight(row.weight)}</td>
    </tr>
  );
}

function SecuritiesTable({ rows, sort, onSort, linkTo }: Readonly<{ rows: readonly SecurityRow[]; sort: SortState; onSort: (key: SecuritySortKey) => void; linkTo: (symbol: string) => string }>) {
  return (
    <div className="card hidden overflow-x-auto md:block">
      <table className="w-full text-sm">
        <caption className="sr-only">
          Securities in your portfolio, sorted by {COLUMNS.find((c) => c.key === sort.key)?.label} {sortLabel(sort.dir)}
        </caption>
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            {COLUMNS.map((col) => (
              <SortableHeader key={col.key} col={col} sort={sort} onSort={onSort} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <SecurityTableRow key={r.symbol} row={r} to={linkTo(r.symbol)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SecurityCards({ rows, linkTo }: Readonly<{ rows: readonly SecurityRow[]; linkTo: (symbol: string) => string }>) {
  return (
    <ul aria-label="Securities in your portfolio" className="space-y-3 md:hidden">
      {rows.map((r) => (
        <li key={r.symbol} className="card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <SecurityLink row={r} to={linkTo(r.symbol)} />
                {r.sold && <SoldBadge />}
              </div>
              <div className="muted truncate text-xs">{r.name}</div>
            </div>
            <div className="text-right">
              <div className="font-semibold tabular-nums">{r.sold ? '—' : formatMoney(r.marketValue)}</div>
              <div className="muted text-xs">{r.sold ? 'sold' : `${formatWeight(r.weight)} of portfolio`}</div>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div>
              <dt className="muted">Sector</dt>
              <dd>{r.sector}</dd>
            </div>
            <div>
              <dt className="muted">Country</dt>
              <dd>{r.country}</dd>
            </div>
            <div>
              <dt className="muted">Currency</dt>
              <dd>{r.currency}</dd>
            </div>
            <div>
              <dt className="muted">Shares</dt>
              <dd className="tabular-nums">{r.sold ? '—' : formatQuantity(r.quantity)}</dd>
            </div>
            <div>
              <dt className="muted">P/L</dt>
              <dd>
                <Change pct={r.pnlPct} value={r.pnl} />
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function SecuritiesBody({ rows, total, query, sort, onSort, onSortValue, linkTo }: Readonly<{
  rows: readonly SecurityRow[];
  total: number;
  query: string;
  sort: SortState;
  onSort: (key: SecuritySortKey) => void;
  onSortValue: (value: string) => void;
  linkTo: (symbol: string) => string;
}>) {
  const sortId = useId();
  if (rows.length === 0) {
    return <p className="muted rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm dark:border-slate-700">{total === 0 ? 'No securities to show.' : `No securities match “${query}”.`}</p>;
  }
  return (
    <>
      <div className="md:hidden">
        <label className="label" htmlFor={sortId}>
          Sort by
        </label>
        <select id={sortId} className="input mb-3" value={`${sort.key}:${sort.dir}`} onChange={(e) => onSortValue(e.target.value)}>
          {COLUMNS.flatMap((c) => [
            <option key={`${c.key}:desc`} value={`${c.key}:desc`}>
              {c.label} ({c.align === 'left' ? 'Z–A' : 'high–low'})
            </option>,
            <option key={`${c.key}:asc`} value={`${c.key}:asc`}>
              {c.label} ({c.align === 'left' ? 'A–Z' : 'low–high'})
            </option>,
          ])}
        </select>
      </div>
      <SecuritiesTable rows={rows} sort={sort} onSort={onSort} linkTo={linkTo} />
      <SecurityCards rows={rows} linkTo={linkTo} />
    </>
  );
}

function Toolbar({ query, onQuery, includeSold, onIncludeSold }: Readonly<{ query: string; onQuery: (q: string) => void; includeSold: boolean; onIncludeSold: (v: boolean) => void }>) {
  const searchId = useId();
  const soldId = useId();
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="min-w-[12rem]">
        <label className="label" htmlFor={searchId}>
          Search securities
        </label>
        <input id={searchId} type="search" className="input" placeholder="Ticker, name, sector…" autoComplete="off" spellCheck={false} value={query} onChange={(e) => onQuery(e.target.value)} />
      </div>
      <label htmlFor={soldId} className="flex items-center gap-2 pb-2 text-sm">
        <input id={soldId} type="checkbox" className="h-4 w-4 rounded border-slate-300 accent-brand-600" checked={includeSold} onChange={(e) => onIncludeSold(e.target.checked)} />
        Include sold positions
      </label>
    </div>
  );
}

/**
 * "Securities in your portfolio": derived from the holdings of the selected scope (the same query and cache as the
 * Holdings page, so it follows every transaction and portfolio change), searchable and sortable, optionally with the
 * sold-out positions. Each row opens the security's detail page.
 */
export function SecuritiesSection() {
  const { scope, ready, withScope, scopeName } = usePortfolioScope();
  const holdings = useHoldings(scope, { enabled: ready });
  const [includeSold, setIncludeSold] = useState(false);
  const closed = useClosedSecurities(scope, { enabled: ready && includeSold });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'marketValue', dir: 'desc' });

  const all = useMemo(() => buildSecurityRows(holdings.data?.holdings ?? [], closed.data?.securities, includeSold), [holdings.data, closed.data, includeSold]);
  const rows = useMemo(() => sortSecurities(filterSecurities(all, query), sort.key, sort.dir), [all, query, sort]);

  const onSort = (key: SecuritySortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultDir(key) }));
  const onSortValue = (value: string) => {
    const [key, dir] = value.split(':') as [SecuritySortKey, SortDir];
    setSort({ key, dir });
  };
  const linkTo = (symbol: string) => withScope(assetPath(symbol));

  let body;
  if (holdings.isError) body = <ErrorState error={holdings.error} onRetry={() => void holdings.refetch()} title="Could not load your securities" />;
  else if (holdings.isPending) {
    body = (
      <LoadingRegion label="Loading securities">
        <Skeleton className="h-40 w-full" />
      </LoadingRegion>
    );
  } else if (all.length === 0 && !includeSold) {
    body = (
      <EmptyState
        title="No securities yet"
        description={`${scopeName || 'This portfolio'} holds no stocks, ETFs or crypto. Add a transaction and it shows up here.`}
        actions={
          <Link to={withScope('/transactions')} className="btn-primary">
            Add a transaction
          </Link>
        }
      />
    );
  } else {
    body = <SecuritiesBody rows={rows} total={all.length} query={query} sort={sort} onSort={onSort} onSortValue={onSortValue} linkTo={linkTo} />;
  }

  return (
    <section aria-labelledby="securities-title" className="mb-10">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="securities-title" className="text-lg font-semibold">
            Securities in your portfolio
          </h2>
          <p className="muted text-sm">Open a security for its price history, dividends and your positions. {scopeName && `Showing ${scopeName}.`}</p>
        </div>
        <Toolbar query={query} onQuery={setQuery} includeSold={includeSold} onIncludeSold={setIncludeSold} />
      </div>
      {includeSold && closed.isError && (
        <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-300">
          Could not load your sold positions.
        </p>
      )}
      {body}
      {holdings.data && (
        <output className="muted mt-2 block text-xs">
          {rows.length} of {all.length} securities
        </output>
      )}
    </section>
  );
}
