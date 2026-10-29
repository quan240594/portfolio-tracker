import type { AlphaVantageProbeResult, ProbeConclusionKind, ProbeOutcome } from '@portfolio/shared';
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

const CONCLUSION_TONE: Readonly<Record<ProbeConclusionKind, 'good' | 'limit' | 'bad'>> = {
  'both-ok': 'good',
  'estimates-unavailable': 'limit',
  throttled: 'limit',
  inconclusive: 'limit',
};

const TONE_CLASS = {
  good: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  limit: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  bad: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
} as const;

function ResultBlock({ result, sample }: Readonly<{ result: AlphaVantageProbeResult; sample: boolean }>) {
  return (
    <div className="space-y-1 text-sm">
      {result.conclusion !== undefined && <p className={`rounded border px-3 py-2 font-medium break-words ${TONE_CLASS[CONCLUSION_TONE[result.conclusion.kind]]}`}>{result.conclusion.text}</p>}
      {result.comparison === undefined ? (
        <p className={`rounded border px-3 py-2 font-medium break-words ${TONE_CLASS[TONE[result.outcome]]}`}>{result.summary}</p>
      ) : (
        <p className="break-words">{result.comparison}</p>
      )}
      {result.message !== undefined && (
        <p className="break-words">
          <span className="muted">Alpha Vantage says: </span>
          <q>{result.message}</q>
        </p>
      )}
      {result.control?.message !== undefined && (
        <p className="break-words">
          <span className="muted">Alpha Vantage says (EARNINGS): </span>
          <q>{result.control.message}</q>
        </p>
      )}
      <p className="muted text-xs">
        {sample ? 'Sample, no call was made. ' : ''}
        {result.call}
        {result.control === undefined ? '' : ' and EARNINGS'} for {result.symbol}, {formatDateTime(result.at)}.
      </p>
    </div>
  );
}

/**
 * Settings > Diagnostics > "Alpha Vantage": one button that makes two real calls with the real key (the app's shared allowance pays for them: the estimates and a
 * control call of the free EARNINGS function) and shows what the provider answered to each side by side, with a plain conclusion, so a failing consensus can be traced
 * to a throttle, a key that cannot read the estimates or a bad key. Nothing where the backend has no such test.
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
        <p className="muted text-sm">
          Makes two real requests for a test company (IBM) with your key, a second apart: the estimates and a control request for the free earnings history. It shows exactly what Alpha Vantage answers to each. It uses two of the 25 free requests of the day.
        </p>
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
