import type { AlphaVantageProbeResult, ProbeOutcome } from '@portfolio/shared';
import { formatDateTime } from '../../lib/format';
import type { AlphaVantageProbeHook } from './useAlphaVantageProbe';

/** Whether the outcome is good news, a limit or a failure: the colour of the summary line. */
const TONE: Readonly<Record<ProbeOutcome, 'good' | 'limit' | 'bad'>> = {
  ok: 'good',
  premium: 'limit',
  'daily-limit': 'limit',
  'burst-limit': 'limit',
  'rate-limited': 'limit',
  'invalid-key': 'bad',
  'no-coverage': 'limit',
  error: 'bad',
};

const TONE_CLASS = {
  good: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  limit: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  bad: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
} as const;

function ResultBlock({ result, sample }: Readonly<{ result: AlphaVantageProbeResult; sample: boolean }>) {
  return (
    <div className="space-y-1 text-sm">
      <p className={`rounded border px-3 py-2 font-medium break-words ${TONE_CLASS[TONE[result.outcome]]}`}>{result.summary}</p>
      {result.message !== undefined && (
        <p className="break-words">
          <span className="muted">Alpha Vantage says: </span>
          <q>{result.message}</q>
        </p>
      )}
      <p className="muted text-xs">
        {sample ? 'Sample, no call was made. ' : ''}
        {result.call} for {result.symbol}, {formatDateTime(result.at)}.
      </p>
    </div>
  );
}

/**
 * Settings > Diagnostics > "Alpha Vantage": one button that makes one real call with the real key (the app's shared allowance pays for it) and shows what
 * the provider answered, so a failing consensus can be traced to a limit, a premium endpoint or a bad key. Nothing where the backend has no such test.
 */
export function AlphaVantageProbeCard({ probe }: Readonly<{ probe: AlphaVantageProbeHook }>) {
  const { status, outcome } = probe;
  if (status === undefined) return null;
  const shown = outcome?.accepted === true ? outcome.result : status.last;
  const budget = outcome?.accepted === true ? outcome.result.budget : status.budget;
  return (
    <section id="alphavantage-probe" aria-labelledby="alphavantage-probe-title" className="card space-y-3 p-4">
      <header className="space-y-1">
        <h2 id="alphavantage-probe-title" className="text-base font-semibold">
          Alpha Vantage
        </h2>
        <p className="muted text-sm">Makes one real request for a test company (IBM) with your key and shows exactly what Alpha Vantage answers. It uses one of the 25 free requests of the day.</p>
        {budget && (
          <p className="muted text-xs">
            Today (UTC): {budget.used} of {budget.limit} requests used by this app.
          </p>
        )}
      </header>
      <div className="space-y-2">
        <button type="button" className="btn-secondary" onClick={probe.runNow} disabled={!status.available || probe.isRunning}>
          {probe.isRunning ? 'Testing…' : 'Test Alpha Vantage now'}
        </button>
        {!status.available && status.reason !== null && <p className="text-sm break-words">{status.reason}</p>}
        {outcome?.accepted === false && <output className="block text-sm break-words">{outcome.message}</output>}
        {probe.runError !== undefined && <p role="alert" className="text-sm">The test could not be run. Try again later.</p>}
      </div>
      {shown ? <ResultBlock result={shown} sample={status.sample === true} /> : <p className="muted text-sm">Not run yet.</p>}
    </section>
  );
}
