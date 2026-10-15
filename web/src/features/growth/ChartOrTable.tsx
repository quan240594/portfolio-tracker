import { useState, type ReactNode } from 'react';
import { TableToggle } from './GrowthTable';

/** A chart with its data-table alternative behind a toggle button. */
export function ChartOrTable({ id, chart, table }: Readonly<{ id: string; chart: ReactNode; table: ReactNode }>) {
  const [showTable, setShowTable] = useState(false);
  return (
    <>
      <div className="mb-2 flex justify-end">
        <TableToggle pressed={showTable} onToggle={() => setShowTable((t) => !t)} controls={id} />
      </div>
      <div id={id}>{showTable ? table : chart}</div>
    </>
  );
}
