import type { WatchlistItem } from '@portfolio/shared';
import { Change } from '../../components/Change';
import { formatMoney } from '../../lib/format';

interface Props {
  items: readonly WatchlistItem[];
  /** Shows a Remove button per row. */
  onRemove?: (symbol: string) => void;
  disabled?: boolean;
}

/** Latest price and day change per watched symbol (prices arrive once the prices service has enriched a new one). */
export function WatchlistTable({ items, onRemove, disabled }: Readonly<Props>) {
  return (
    <div className="card relative overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Watchlist</caption>
        <thead>
          <tr className="muted border-b border-slate-200 text-left text-xs dark:border-slate-800">
            <th scope="col" className="px-3 py-2.5 font-medium">Symbol</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Price</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Day change</th>
            {onRemove && <th scope="col" className="px-3 py-2.5"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.symbol} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
              <th scope="row" className="min-w-[9rem] px-3 py-2.5 text-left font-normal">
                <span className="block font-semibold">{w.symbol}</span>
                {w.name && <span className="muted block max-w-xs text-xs break-words">{w.name}</span>}
              </th>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {w.price === undefined ? <span className="muted">Waiting for price…</span> : formatMoney(w.price, w.currency, { maxDigits: w.price < 1 ? 6 : 2 })}
              </td>
              <td className="px-3 py-2.5 text-right">
                {w.change === undefined || w.changePct === undefined ? <span className="muted">—</span> : <Change amount={w.change} pct={w.changePct} currency={w.currency} />}
              </td>
              {onRemove && (
                <td className="px-3 py-2.5 text-right">
                  <button type="button" disabled={disabled} className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40" aria-label={`Remove ${w.symbol} from watchlist`} onClick={() => onRemove(w.symbol)}>
                    Remove
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
