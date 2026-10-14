import { useId, useMemo, useState } from 'react';
import type { Holding } from '@portfolio/shared';
import { Change } from '../../components/Change';
import { formatMoney, formatPercent, formatQuantity, formatWeight } from '../../lib/format';
import { sortHoldings, type SortDir, type SortKey } from './sortHoldings';

interface Column {
  key: SortKey;
  label: string;
  align: 'left' | 'right';
  /** Longer explanation, shown as a tooltip and linked to the footnote below the table. */
  hint?: string;
}

export const CURRENCY_EFFECT_HINT =
  'The part of the unrealized P&L caused by exchange-rate moves since purchase (e.g. a weaker US dollar against the euro). Holdings that trade in euros have none.';

const COLUMNS: Column[] = [
  { key: 'symbol', label: 'Holding', align: 'left' },
  { key: 'quantity', label: 'Quantity', align: 'right' },
  { key: 'averageCostBase', label: 'Avg cost', align: 'right' },
  { key: 'priceBase', label: 'Price', align: 'right' },
  { key: 'marketValue', label: 'Market value', align: 'right' },
  { key: 'unrealizedPnl', label: 'Unrealized P&L', align: 'right' },
  { key: 'unrealizedPnlPct', label: 'P&L %', align: 'right' },
  { key: 'currencyEffect', label: 'Currency effect', align: 'right', hint: CURRENCY_EFFECT_HINT },
  { key: 'dayChange', label: 'Day change', align: 'right' },
  { key: 'weight', label: 'Weight', align: 'right' },
];

const sortLabel = (dir: SortDir) => (dir === 'asc' ? 'ascending' : 'descending');
const sortArrow = (dir: SortDir) => (dir === 'asc' ? '▲' : '▼');

const unitDigits = (price: number) => (price < 1 ? 6 : 2);

/** Per-unit amount in the base currency, with the trading-currency amount underneath for foreign holdings. */
function UnitAmount({ base, local, holding, currency }: Readonly<{ base: number; local: number; holding: Holding; currency: string }>) {
  return (
    <>
      <span className="block">{formatMoney(base, currency, { maxDigits: unitDigits(holding.priceBase) })}</span>
      {holding.currency !== currency && (
        <span className="muted block text-xs" title={`In ${holding.currency}, the trading currency`}>
          {formatMoney(local, holding.currency, { maxDigits: unitDigits(holding.priceLocal) })}
        </span>
      )}
    </>
  );
}

function CurrencyEffect({ holding, currency }: Readonly<{ holding: Holding; currency: string }>) {
  if (holding.currency === currency) {
    return (
      <span className="muted" title={`No currency effect: ${holding.symbol} trades in ${currency}`}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">none</span>
      </span>
    );
  }
  return (
    <span title={CURRENCY_EFFECT_HINT}>
      <Change amount={holding.currencyEffect} currency={currency} />
    </span>
  );
}

export function StaleBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 uppercase dark:bg-amber-900/40 dark:text-amber-200"
      title="The latest price could not be refreshed; the last known price is shown."
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor">
        <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm.75 4a.75.75 0 0 0-1.5 0v4.25c0 .2.08.39.22.53l2.5 2.5a.75.75 0 1 0 1.06-1.06l-2.28-2.28V6Z" />
      </svg>
      Stale price
    </span>
  );
}

function WeightBar({ weight }: Readonly<{ weight: number }>) {
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 lg:block dark:bg-slate-800" aria-hidden="true">
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, weight * 100)}%` }} />
      </div>
      <span className="w-12 tabular-nums">{formatWeight(weight)}</span>
    </div>
  );
}

interface Props {
  holdings: Holding[];
  currency: string;
}

export function HoldingsTable({ holdings, currency }: Readonly<Props>) {
  const hintId = useId();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'marketValue', dir: 'desc' });
  const sorted = useMemo(() => sortHoldings(holdings, sort.key, sort.dir), [holdings, sort]);

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'symbol' ? 'asc' : 'desc' }));

  return (
    <>
      {/* Desktop / tablet */}
      <div className="card hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">Holdings, sorted by {COLUMNS.find((c) => c.key === sort.key)?.label} {sortLabel(sort.dir)}</caption>
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800">
              {COLUMNS.map((col) => {
                const active = sort.key === col.key;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={active ? sortLabel(sort.dir) : 'none'}
                    className={`px-3 py-2.5 font-medium whitespace-nowrap ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                  >
                    <button
                      type="button"
                      title={col.hint}
                      aria-describedby={col.hint ? hintId : undefined}
                      onClick={() => toggle(col.key)}
                      className={`inline-flex items-center gap-1 rounded hover:text-slate-900 dark:hover:text-white ${active ? 'text-slate-900 dark:text-white' : 'muted'}`}
                    >
                      {col.label}
                      <span aria-hidden="true" className={`text-[10px] ${active ? '' : 'opacity-30'}`}>
                        {active ? sortArrow(sort.dir) : '▲▼'}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((h) => (
              <tr key={h.symbol} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40">
                <th scope="row" className="px-3 py-2.5 text-left font-normal">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{h.symbol}</span>
                    {h.priceStale && <StaleBadge />}
                  </div>
                  <div className="muted max-w-[16rem] truncate text-xs">{h.name}</div>
                </th>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatQuantity(h.quantity)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  <UnitAmount base={h.averageCostBase} local={h.averageCostLocal} holding={h} currency={currency} />
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  <UnitAmount base={h.priceBase} local={h.priceLocal} holding={h} currency={currency} />
                </td>
                <td className="px-3 py-2.5 text-right font-medium tabular-nums">{formatMoney(h.marketValue, currency)}</td>
                <td className="px-3 py-2.5 text-right">
                  <Change amount={h.unrealizedPnl} currency={currency} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Change pct={h.unrealizedPnlPct} value={h.unrealizedPnl} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <CurrencyEffect holding={h} currency={currency} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <div className="flex flex-col items-end">
                    <Change amount={h.dayChange} currency={currency} />
                    <span className="muted text-xs tabular-nums">{formatPercent(h.dayChangePct, { signed: true })}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <WeightBar weight={h.weight} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile */}
      <div className="md:hidden">
        <label className="label" htmlFor="holdings-sort">
          Sort by
        </label>
        <select
          id="holdings-sort"
          className="input mb-3"
          value={`${sort.key}:${sort.dir}`}
          onChange={(e) => {
            const [key, dir] = e.target.value.split(':') as [SortKey, SortDir];
            setSort({ key, dir });
          }}
        >
          {COLUMNS.flatMap((c) => [
            <option key={`${c.key}:desc`} value={`${c.key}:desc`}>
              {c.label} ({c.key === 'symbol' ? 'Z–A' : 'high–low'})
            </option>,
            <option key={`${c.key}:asc`} value={`${c.key}:asc`}>
              {c.label} ({c.key === 'symbol' ? 'A–Z' : 'low–high'})
            </option>,
          ])}
        </select>
        <ul className="space-y-3" aria-label="Holdings">
          {sorted.map((h) => (
            <li key={h.symbol} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{h.symbol}</span>
                    {h.priceStale && <StaleBadge />}
                  </div>
                  <div className="muted truncate text-xs">{h.name}</div>
                </div>
                <div className="text-right">
                  <div className="font-semibold tabular-nums">{formatMoney(h.marketValue, currency)}</div>
                  <div className="muted text-xs">{formatWeight(h.weight)} of portfolio</div>
                </div>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <div>
                  <dt className="muted">Quantity</dt>
                  <dd className="tabular-nums">{formatQuantity(h.quantity)}</dd>
                </div>
                <div>
                  <dt className="muted">Price</dt>
                  <dd className="tabular-nums">
                    <UnitAmount base={h.priceBase} local={h.priceLocal} holding={h} currency={currency} />
                  </dd>
                </div>
                <div>
                  <dt className="muted">Avg cost</dt>
                  <dd className="tabular-nums">
                    <UnitAmount base={h.averageCostBase} local={h.averageCostLocal} holding={h} currency={currency} />
                  </dd>
                </div>
                <div>
                  <dt className="muted">Unrealized P&amp;L</dt>
                  <dd>
                    <Change amount={h.unrealizedPnl} pct={h.unrealizedPnlPct} currency={currency} />
                  </dd>
                </div>
                <div>
                  <dt className="muted">Currency effect</dt>
                  <dd>
                    <CurrencyEffect holding={h} currency={currency} />
                  </dd>
                </div>
                <div>
                  <dt className="muted">Day change</dt>
                  <dd>
                    <Change amount={h.dayChange} pct={h.dayChangePct} currency={currency} />
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </div>

      <p id={hintId} className="muted mt-3 text-xs">
        Avg cost and price are in {currency} (purchase-date and today's exchange rates); for holdings in another currency the
        trading-currency amount is shown underneath. Currency effect: {CURRENCY_EFFECT_HINT.charAt(0).toLowerCase() + CURRENCY_EFFECT_HINT.slice(1)}
      </p>
    </>
  );
}
