import type { RebalanceResult, RebalanceRow } from '@portfolio/shared';
import { formatMoney, formatPercent } from '../../lib/format';

const driftClass = (pp: number) => {
  if (Math.abs(pp) < 0.05) return 'muted';
  return pp > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-sky-700 dark:text-sky-300';
};

function DriftCell({ pp, value }: Readonly<{ pp: number; value: number }>) {
  return (
    <td className={`px-3 py-2 text-right tabular-nums ${driftClass(pp)}`}>
      <span className="block">{formatPercent(pp, { signed: true, digits: 1 })}</span>
      <span className="block text-xs">{formatMoney(value, 'EUR', { signed: true })}</span>
    </td>
  );
}

function Row({ row }: Readonly<{ row: RebalanceRow }>) {
  return (
    <tr className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
      <th scope="row" className="px-3 py-2 text-left font-medium">
        <span className="flex items-center gap-2">
          {row.color && <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />}
          {row.name}
        </span>
      </th>
      <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.targetWeight, { digits: 1 })}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.weightBefore, { digits: 1 })}</td>
      <DriftCell pp={row.driftBefore} value={row.driftValueBefore} />
      <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.weightAfter, { digits: 1 })}</td>
      <DriftCell pp={row.driftAfter} value={row.driftValueAfter} />
    </tr>
  );
}

/** Target vs current weight per category, with drift (percentage points and EUR) before and after the trades. */
export function DriftTable({ result }: Readonly<{ result: RebalanceResult }>) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Drift from target allocation per category</caption>
        <thead>
          <tr className="muted border-b border-slate-200 text-xs dark:border-slate-800">
            <th scope="col" className="px-3 py-2.5 text-left font-medium">Category</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Target</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Now</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Drift now</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">After</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Drift after</th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => <Row key={r.categoryId} row={r} />)}
          <Row row={{ ...result.unallocated, name: 'Unallocated' }} />
        </tbody>
      </table>
    </div>
  );
}
