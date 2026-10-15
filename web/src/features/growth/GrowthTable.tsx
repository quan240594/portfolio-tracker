import { TableShell, numCell, rowClass, type Column } from '../analytics/TableShell';

/** Data-table alternative of a chart: first column is the row header, the others are right-aligned numbers. */
export function GrowthTable({ caption, columns, rows }: Readonly<{ caption: string; columns: readonly string[]; rows: readonly (readonly string[])[] }>) {
  const cols: Column[] = columns.map((label, i) => (i === 0 ? { label } : { label, align: 'right' }));
  return (
    <TableShell caption={caption} columns={cols}>
      {rows.map((cells) => (
        <tr key={cells[0]} className={rowClass}>
          <th scope="row" className="py-2 pr-3 text-left font-medium whitespace-nowrap">
            {cells[0]}
          </th>
          {cells.slice(1).map((cell, i) => (
            <td key={`${cols[i + 1]?.label}`} className={numCell}>
              {cell}
            </td>
          ))}
        </tr>
      ))}
    </TableShell>
  );
}

/** Button that swaps a chart for its data table. */
export function TableToggle({ pressed, onToggle, controls }: Readonly<{ pressed: boolean; onToggle: () => void; controls: string }>) {
  return (
    <button type="button" className="btn-secondary px-2.5 py-1 text-xs" aria-pressed={pressed} aria-controls={controls} onClick={onToggle}>
      Data table
    </button>
  );
}
