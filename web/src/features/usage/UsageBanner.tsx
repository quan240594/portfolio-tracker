import { useEffect, useState } from 'react';
import { USAGE_METRIC_LABELS, type UsageSnapshot } from '@portfolio/shared';
import { formatPercent } from '../../lib/format';
import { BUDGET_EXHAUSTED, BUDGET_UNAVAILABLE, budgetMessage, formatLocalTime, useBudgetNotice } from './budgetSignal';
import { StatusIcon, STATE_TONE } from './StatusIcon';
import { useUsage } from './useUsage';
import { metricsInState, onlyStorageBlocked } from './usageView';

const DISMISS_KEY = 'usage-banner-dismissed';

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function storeDismissed(value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(DISMISS_KEY);
    else sessionStorage.setItem(DISMISS_KEY, value);
  } catch {
    // Storage can be unavailable (private mode); the banner then simply comes back on the next page load.
  }
}

/** A dismissal is for one UTC day: the warning returns the next day. A worse state is not dismissible at all. */
const warnKey = (snapshot: UsageSnapshot) => `${snapshot.day}:warn`;

function warnText(snapshot: UsageSnapshot): string {
  const high = metricsInState(snapshot, 'warn')
    .map((metric) => `${USAGE_METRIC_LABELS[metric]} ${formatPercent(snapshot.metrics[metric].percent, { digits: 0 })}`)
    .join(', ');
  return `Free-plan usage is getting high (${high}). At ${snapshot.thresholds.blockPercent} % of any cap the app pauses new work until the reset at ${formatLocalTime(snapshot.resetsAt)}.`;
}

function pausedText(snapshot: UsageSnapshot): string {
  if (onlyStorageBlocked(snapshot)) {
    return 'Paused to stay inside the free plan: the stored data is at its cap. Removing data makes room again.';
  }
  return `Paused to stay inside the free plan, resumes at ${formatLocalTime(snapshot.resetsAt)}.`;
}

interface NoticeProps {
  tone: keyof typeof STATE_TONE;
  children: React.ReactNode;
  onDismiss?: () => void;
}

function Notice({ tone, children, onDismiss }: Readonly<NoticeProps>) {
  return (
    <aside aria-label="Free-plan usage" className={`border-b ${STATE_TONE[tone]}`}>
      <div className="mx-auto flex max-w-7xl items-start gap-3 px-4 py-2 text-xs sm:px-6 sm:text-sm">
        <StatusIcon state={tone} className="mt-0.5 h-4 w-4" />
        <output className="block min-w-0 flex-1">{children}</output>
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="shrink-0 rounded-md border border-current px-2 py-0.5 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10">
            Dismiss
          </button>
        )}
      </div>
    </aside>
  );
}

/**
 * Page-level, non-blocking notice. `warn` can be dismissed for the session (it returns on a new UTC day); a paused state
 * (usage at the block threshold, or the API answered 429 BUDGET_EXHAUSTED) stays; a 503 BUDGET_UNAVAILABLE gets its own message.
 */
export function UsageBanner() {
  const { snapshot } = useUsage();
  const notice = useBudgetNotice();
  const [dismissed, setDismissed] = useState(readDismissed);

  const exhausted = notice?.code === BUDGET_EXHAUSTED;
  const warning = snapshot?.state === 'warn' && !exhausted;

  // Once the state is no longer a warning (better or worse), a later warning is news again.
  useEffect(() => {
    if (!snapshot || warning || dismissed === null) return;
    storeDismissed(null);
    setDismissed(null);
  }, [snapshot, warning, dismissed]);

  if (notice?.code === BUDGET_EXHAUSTED) return <Notice tone="blocked">{budgetMessage(BUDGET_EXHAUSTED, notice.resumesAt)}</Notice>;
  if (snapshot?.state === 'blocked') return <Notice tone="blocked">{pausedText(snapshot)}</Notice>;
  if (notice?.code === BUDGET_UNAVAILABLE) return <Notice tone="unavailable">{budgetMessage(BUDGET_UNAVAILABLE, notice.resumesAt)}</Notice>;
  if (!warning || dismissed === warnKey(snapshot)) return null;
  const dismiss = () => {
    storeDismissed(warnKey(snapshot));
    setDismissed(warnKey(snapshot));
  };
  return (
    <Notice tone="warn" onDismiss={dismiss}>
      {warnText(snapshot)}
    </Notice>
  );
}
