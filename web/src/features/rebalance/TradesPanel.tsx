import { useState } from 'react';
import { rebalanceTradesToCsv, type RebalanceResult } from '@portfolio/shared';
import { formatMoney, formatQuantity } from '../../lib/format';

/** Suggested trades, warnings and leftover cash; the trades can be copied as CSV. */
export function TradesPanel({ result }: Readonly<{ result: RebalanceResult }>) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const { trades } = result;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rebalanceTradesToCsv(trades));
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <section className="card p-4" aria-labelledby="trades-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="trades-title" className="font-semibold">Suggested trades</h2>
        {trades.length > 0 && (
          <button type="button" className="btn-secondary" onClick={() => void copy()}>Copy as CSV</button>
        )}
      </div>
      <div role="status" aria-live="polite" className="empty:hidden">
        {copied === 'ok' && <p className="mb-2 text-sm text-emerald-700 dark:text-emerald-300">Copied {trades.length} trades to the clipboard.</p>}
        {copied === 'failed' && <p className="mb-2 text-sm text-red-700 dark:text-red-300">Could not access the clipboard.</p>}
      </div>
      {trades.length === 0 ? (
        <p className="muted text-sm">No trades needed with these settings.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Suggested trades</caption>
            <thead>
              <tr className="muted border-b border-slate-200 text-xs dark:border-slate-800">
                <th scope="col" className="px-3 py-2 text-left font-medium">Action</th>
                <th scope="col" className="px-3 py-2 text-left font-medium">Holding</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Units</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Price</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={`${t.action}-${t.symbol}`} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                  <td className="px-3 py-2">
                    <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${t.action === 'BUY' ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' : 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200'}`}>
                      {t.action}
                    </span>
                  </td>
                  <td className="px-3 py-2"><span className="font-medium">{t.symbol}</span> <span className="muted text-xs">{t.name}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(t.units)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(t.price, 'EUR')}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{formatMoney(t.value, 'EUR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted mt-3 text-sm">Leftover cash: <strong className="tabular-nums">{formatMoney(result.leftoverCash, 'EUR')}</strong></p>
      {result.warnings.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800 dark:text-amber-200">
          {result.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
    </section>
  );
}
