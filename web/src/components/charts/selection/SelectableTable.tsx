import { useId, type ReactNode } from 'react';
import type { SelectionView } from './useSeriesSelection';

export interface SelectableColumn {
  /** Series key shared with the legend. */
  key: string;
  label: string;
  /** false = a plain header that cannot be excluded: totals, derived or descriptive columns. Default true. */
  selectable?: boolean;
}

export interface SelectableRow {
  /** Row id shared with the chart's categories (for a donut: the slice key). */
  id: string;
  /** Text of the row header, which is also the toggle's name. */
  header: string;
  /** One cell per column. */
  cells: readonly ReactNode[];
  /** false = a plain header that cannot be excluded: totals rows. Default true. */
  selectable?: boolean;
  /** Marks the row that matters (e.g. the target year): `aria-current` and a highlight. */
  current?: boolean;
  /** Plain text after the header toggle (a badge); it is not part of the toggle's name. */
  note?: ReactNode;
}

interface TableProps {
  /** Accessible name of the table (visually hidden). */
  caption: string;
  /** Heading of the first column, e.g. "Month" or "Holding". */
  rowHeader: string;
  columns: readonly SelectableColumn[];
  rows: readonly SelectableRow[];
  selection: SelectionView;
  className?: string;
  /** Replaces the table element's classes (default `w-full text-xs`), e.g. for a minimum width. */
  tableClassName?: string;
  /** Wraps the table in a div with these classes (a scroll area, e.g. `overflow-x-auto` or a max height) so the hint and "Show all" stay in view. */
  scrollClassName?: string;
  /** Extra classes of the `thead`, e.g. a sticky header inside a scrolling wrapper. */
  headClassName?: string;
}

const HEADER_BUTTON = 'min-h-6 cursor-pointer rounded px-1 py-0.5 font-medium hover:bg-slate-100 dark:hover:bg-slate-800';

interface ToggleProps {
  label: string;
  visible: boolean;
  onToggle: () => void;
  className?: string;
}

function HeaderToggle({ label, visible, onToggle, className = '' }: Readonly<ToggleProps>) {
  return (
    <button type="button" aria-pressed={visible} onClick={onToggle} className={`${HEADER_BUTTON} ${className} ${visible ? '' : 'line-through'}`}>
      {label}
    </button>
  );
}

function ScrollArea({ className, children }: Readonly<{ className?: string; children: ReactNode }>) {
  return className ? <div className={className}>{children}</div> : <>{children}</>;
}

/**
 * The numbers behind a chart. The header buttons of the series columns and of the rows include/exclude that series or row in the chart
 * (the same state as the legend); excluded ones are dimmed and struck through. A real table: `th scope`, no ARIA grid.
 */
export function SelectableTable({ caption, rowHeader, columns, rows, selection, className = '', tableClassName = 'w-full text-xs', scrollClassName, headClassName = '' }: Readonly<TableProps>) {
  const hintId = useId();
  const columnState = columns.map((c) => ({ ...c, selectable: c.selectable !== false, visible: selection.isSeriesVisible(c.key) }));
  return (
    <div className={className}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p id={hintId} className="muted text-xs">
          Click a column or row header to include or exclude it from the chart
        </p>
        {selection.hasHidden && (
          <button type="button" onClick={selection.reset} className="min-h-6 cursor-pointer rounded px-1 text-xs font-medium text-brand-700 underline dark:text-brand-400">
            Show all
          </button>
        )}
      </div>
      <ScrollArea className={scrollClassName}>
        <table className={tableClassName} aria-describedby={hintId}>
          <caption className="sr-only">{caption}</caption>
          <thead className={headClassName || undefined}>
            <tr className="muted border-b border-slate-200 text-left dark:border-slate-800">
              <th scope="col" className="py-1 pr-3 font-medium">
                {rowHeader}
              </th>
              {columnState.map((c) => (
                <th key={c.key} scope="col" className="py-1 pr-3 text-right font-medium">
                  {c.selectable ? <HeaderToggle label={c.label} visible={c.visible} onToggle={() => selection.toggleSeries(c.key)} /> : c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rowVisible = selection.isRowVisible(row.id);
              return (
                <tr key={row.id} aria-current={row.current ? 'true' : undefined} className={`border-b border-slate-100 last:border-0 dark:border-slate-800/60 ${row.current ? 'bg-brand-50 font-medium dark:bg-brand-600/20' : ''}`}>
                  <th scope="row" className="py-1 pr-3 text-left font-medium">
                    {row.selectable === false ? row.header : <HeaderToggle label={row.header} visible={rowVisible} onToggle={() => selection.toggleRow(row.id)} className="text-left" />}
                    {row.note}
                  </th>
                  {row.cells.map((cell, i) => {
                    const column = columnState[i]!;
                    const shown = rowVisible && (!column.selectable || column.visible);
                    return (
                      <td key={column.key} className={`py-1 pr-3 text-right tabular-nums ${shown ? '' : 'line-through opacity-50'}`}>
                        {cell}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

/** `SelectableTable` in the usual "Show data table" disclosure; `extra` adds plain content (more tables) below it. */
export function SelectableDataTable({ extra, ...table }: Readonly<TableProps & { extra?: ReactNode }>) {
  return (
    <details className="mt-2 text-xs">
      <summary className="muted w-fit cursor-pointer rounded px-1 select-none hover:text-slate-900 dark:hover:text-white">Show data table</summary>
      <div className="mt-2 max-h-72 overflow-auto">
        <SelectableTable {...table} />
        {extra}
      </div>
    </details>
  );
}
