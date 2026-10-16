import { useState, type ReactNode } from 'react';
import { NothingSelected, SelectableLegend, type LegendEntry, type SeriesSelection } from '../../components/charts/selection';

/** Button that swaps a chart for its data table. */
export function TableToggle({ pressed, onToggle, controls }: Readonly<{ pressed: boolean; onToggle: () => void; controls: string }>) {
  return (
    <button type="button" className="btn-secondary px-2.5 py-1 text-xs" aria-pressed={pressed} aria-controls={controls} onClick={onToggle}>
      Data table
    </button>
  );
}

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

interface SelectableProps {
  id: string;
  entries: readonly LegendEntry[];
  selection: SeriesSelection;
  legendTestId: string;
  legendLabel: string;
  chart: ReactNode;
  table: ReactNode;
}

/** The legend and a chart (or its data table), sharing one include/exclude selection; "Nothing selected" replaces the chart when everything is excluded. */
export function SelectableChartOrTable({ id, entries, selection, legendTestId, legendLabel, chart, table }: Readonly<SelectableProps>) {
  return (
    <>
      <SelectableLegend entries={entries} selection={selection} label={legendLabel} testId={legendTestId} />
      <ChartOrTable id={id} chart={selection.nothingSelected ? <NothingSelected onShowAll={selection.reset} /> : chart} table={table} />
    </>
  );
}
