import { useState } from 'react';
import type { EarningsStatusResponse } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useBackfillEarnings } from '../../api/earningsHooks';
import { backfillText, checkedLines, lastPassText, notCountedText, totalsText, type CheckedLine } from './checked';

const TONE_CLASS: Readonly<Record<CheckedLine['tone'], string>> = {
  ok: '',
  wait: '',
  problem: 'text-amber-800 dark:text-amber-300',
};

function FetchAll({ failed }: Readonly<{ failed: number }>) {
  const backfill = useBackfillEarnings();
  const result = backfill.data;
  let message: string | null = null;
  if (backfill.isError) message = errorMessage(backfill.error);
  else if (result?.accepted) message = 'Started. The page fills as releases are read; it can take a day or more when the daily AI allowance runs out.';
  else if (result?.reason === 'rate-limited') message = 'Started less than an hour ago. Try again later.';
  else if (result?.reason === 'not-configured') message = 'Not switched on on the server yet.';
  return (
    <div className="flex flex-col gap-1">
      <button type="button" className="btn-secondary self-start" disabled={backfill.isPending} onClick={() => backfill.mutate()}>
        {backfill.isPending ? 'Asking…' : 'Fetch all now'}
      </button>
      <span className="muted text-xs">Rescans your current holdings from the start.</span>
      {failed > 0 && <span className="muted text-xs">This also tries the {failed} release{failed === 1 ? '' : 's'} that could not be read again.</span>}
      {message && <output className="muted block text-xs">{message}</output>}
    </div>
  );
}

/**
 * "What was checked": one line per held company with the stage and the reason, the totals, the last full pass and the progress of the backfill.
 * Open by default while there is nothing else to show: that is when the owner needs to know why.
 */
export function CheckedSection({ status, selected, hasSummaries }: Readonly<{ status: EarningsStatusResponse; selected?: string; hasSummaries: boolean }>) {
  const [open, setOpen] = useState(!hasSummaries);
  const lines = checkedLines(status, selected);
  const backfill = backfillText(status.backfill);
  const notCounted = notCountedText(status);
  return (
    <details className="card p-3 text-sm" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">What was checked</summary>
      <div className="mt-2 min-w-0 space-y-3">
        <p className="muted break-words">{totalsText(status)}</p>
        {notCounted && <p className="muted break-words">{notCounted}</p>}
        <p className="muted break-words">{lastPassText(status)}</p>
        {backfill && (
          <section aria-labelledby="earnings-backfill-title" className="min-w-0 space-y-1">
            <h3 id="earnings-backfill-title" className="font-medium">
              Reading the latest quarters
            </h3>
            <p className="break-words">{backfill.headline}</p>
            {backfill.progress && backfill.progress.total > 0 && <progress className="h-2 w-full" aria-label="Releases read" value={backfill.progress.done} max={backfill.progress.total} />}
            {backfill.detail && <p className="muted break-words">{backfill.detail}</p>}
            <FetchAll failed={status.backfill?.failed ?? 0} />
          </section>
        )}
        {lines.length > 0 && (
          <ul className="space-y-1">
            {lines.map((line) => (
              <li key={line.symbol} className={`min-w-0 break-words ${TONE_CLASS[line.tone]}`}>
                {line.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
