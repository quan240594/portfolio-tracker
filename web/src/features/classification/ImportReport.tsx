import type { ClassificationImportResponse, ClassificationMatch, ClassificationUnmatched, SnowballIssue } from '@portfolio/shared';
import { FIELD_LABELS, REASON_LABELS, valueLabel } from './labels';

type ReportRow = { kind: 'matched'; index: number; match: ClassificationMatch } | { kind: 'unmatched'; index: number; row: ClassificationUnmatched };

export interface ReportCounts {
  rows: number;
  matched: number;
  withChanges: number;
  unmatched: number;
}

export function countReport({ matched, unmatched }: Pick<ClassificationImportResponse, 'matched' | 'unmatched'>): ReportCounts {
  return {
    rows: matched.length + unmatched.length,
    matched: matched.length,
    withChanges: matched.filter((m) => m.changes.length > 0).length,
    unmatched: unmatched.length,
  };
}

/** Every row of the file in file order, matched or not. */
function reportRows({ matched, unmatched }: Pick<ClassificationImportResponse, 'matched' | 'unmatched'>): ReportRow[] {
  const rows: ReportRow[] = [
    ...matched.map((match): ReportRow => ({ kind: 'matched', index: match.index, match })),
    ...unmatched.map((row): ReportRow => ({ kind: 'unmatched', index: row.index, row })),
  ];
  return rows.toSorted((a, b) => a.index - b.index);
}

function Stat({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <div className="min-w-0">
      <dt className="muted text-xs">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Changes({ match }: Readonly<{ match: ClassificationMatch }>) {
  if (match.changes.length === 0) return <span className="muted">No change</span>;
  return (
    <ul className="space-y-1">
      {match.changes.map((change) => (
        <li key={change.field} className="break-words">
          <span className="font-medium">{FIELD_LABELS[change.field]}</span>: <span className="muted">{valueLabel(change.field, change.from)}</span>
          <span> → </span>
          <span className="font-medium">{valueLabel(change.field, change.to)}</span>
        </li>
      ))}
    </ul>
  );
}

function MatchedCells({ match }: Readonly<{ match: ClassificationMatch }>) {
  return (
    <>
      <td className="px-2 py-2 align-top break-words">
        <span className="font-mono">{match.ticker}</span>
        <div className="muted">
          matches <span className="font-mono">{match.symbol}</span> by {match.matchedBy === 'isin' ? 'ISIN' : 'ticker'}
        </div>
      </td>
      <td className="px-2 py-2 align-top">
        <Changes match={match} />
      </td>
    </>
  );
}

function UnmatchedCells({ row }: Readonly<{ row: ClassificationUnmatched }>) {
  return (
    <>
      <td className="px-2 py-2 align-top break-words">
        <span className="font-mono">{row.ticker}</span>
        {row.isin !== undefined && <div className="muted font-mono">{row.isin}</div>}
      </td>
      <td className="px-2 py-2 align-top break-words text-amber-800 dark:text-amber-200">
        <span className="font-medium">Not matched.</span> {REASON_LABELS[row.reason]}
      </td>
    </>
  );
}

/** Summary, the row-by-row table (matched with what changes, unmatched with the reason) and the parser's notes on the file. */
export function ImportReport({ response, issues, caption }: Readonly<{ response: ClassificationImportResponse; issues: readonly SnowballIssue[]; caption: string }>) {
  const counts = countReport(response);
  const rows = reportRows(response);
  return (
    <div className="space-y-4">
      <dl aria-label="Summary" className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Stat label="Rows read" value={counts.rows} />
        <Stat label="Matched" value={counts.matched} />
        <Stat label="With changes" value={counts.withChanges} />
        <Stat label="Not matched" value={counts.unmatched} />
      </dl>

      <div className="max-h-[45vh] overflow-auto rounded-md border border-slate-200 dark:border-slate-800">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-slate-50 dark:bg-slate-950/60">
            <tr>
              <th scope="col" className="px-2 py-1.5">Row</th>
              <th scope="col" className="px-2 py-1.5">In your file</th>
              <th scope="col" className="px-2 py-1.5">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.index} className="border-t border-slate-100 dark:border-slate-800">
                <th scope="row" className="px-2 py-2 align-top font-normal tabular-nums">{row.index + 1}</th>
                {row.kind === 'matched' ? <MatchedCells match={row.match} /> : <UnmatchedCells row={row.row} />}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {issues.length > 0 && (
        <section aria-label="Notes on the file" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          <h3 className="font-semibold">Notes on the file</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {issues.map((issue) => (
              <li key={`${issue.line}-${issue.message}`} className="break-words">
                Line {issue.line}: {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
