import { useEffect, useId, useRef, useState } from 'react';
import type { UsageSnapshot } from '@portfolio/shared';
import { formatCount, formatDate } from '../../lib/format';
import { formatLocalTime } from './budgetSignal';
import { StatusIcon, STATE_TONE } from './StatusIcon';
import { useUsage } from './useUsage';
import { METRIC_STATE_TEXT, STATE_CHIP_TEXT, metricRows, type MetricRow } from './usageView';

const CHIP_CLASS =
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium hover:brightness-95 dark:hover:brightness-110';

/** A metric's bar: native <meter>, with the state spelled out in text beside it. */
function MetricBar({ row, snapshot }: Readonly<{ row: MetricRow; snapshot: UsageSnapshot }>) {
  const labelId = useId();
  const { warnPercent, blockPercent } = snapshot.thresholds;
  return (
    <li>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span id={labelId} className="font-medium">
          {row.label}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1">
          <StatusIcon state={row.state} className="h-3.5 w-3.5" />
          {METRIC_STATE_TEXT[row.state]}
        </span>
      </div>
      {/* optimum=0 makes "below the warn threshold" the good region; the offsets put exactly 60 % / 80 % in the next one. */}
      <meter
        aria-labelledby={labelId}
        className="usage-meter mt-1 block h-2 w-full"
        min={0}
        max={100}
        low={warnPercent - 0.01}
        high={blockPercent - 0.01}
        optimum={0}
        value={Math.min(row.percent, 100)}
      >
        {row.percent}%
      </meter>
      <p className="muted mt-1 text-xs">{row.summary}</p>
    </li>
  );
}

interface PanelProps {
  snapshot: UsageSnapshot;
  onClose: () => void;
  panelRef: React.RefObject<HTMLElement>;
  id: string;
}

function UsagePanel({ snapshot, onClose, panelRef, id }: Readonly<PanelProps>) {
  const headingId = useId();
  const unknown = snapshot.state === 'unavailable';
  return (
    <section
      ref={panelRef}
      id={id}
      aria-labelledby={headingId}
      tabIndex={-1}
      className="card absolute right-0 z-40 mt-2 max-h-[75vh] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto p-4 text-sm shadow-lg focus:outline-none"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="font-semibold">
          Free-plan usage
        </h2>
        <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={onClose}>
          Close
        </button>
      </div>
      <p className={`mt-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATE_TONE[snapshot.state]}`}>
        <StatusIcon state={snapshot.state} className="h-3.5 w-3.5" />
        {STATE_CHIP_TEXT[snapshot.state]}
      </p>
      <p className="muted mt-2 text-xs">
        Free plan caps are never exceeded: at {formatCount(snapshot.thresholds.blockPercent)} % of any cap the app pauses new work until the reset.
      </p>
      {unknown ? (
        <p className="mt-3 text-xs">
          The usage could not be read right now, so the app only allows reading until it can. The figures will return by themselves.
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {metricRows(snapshot).map((row) => (
            <MetricBar key={row.metric} row={row} snapshot={snapshot} />
          ))}
        </ul>
      )}
      <p className="muted mt-3 text-xs">
        Daily counters reset at {formatLocalTime(snapshot.resetsAt)} (00:00 UTC); stored data is a level and does not reset.
      </p>
      <p className="muted mt-1 text-xs">Updated {formatDate(snapshot.generatedAt, { hour: '2-digit', minute: '2-digit' })}.</p>
    </section>
  );
}

/**
 * Header chip with the overall free-plan state; opens a panel with every metric. Renders nothing while the backend does
 * not expose /usage (AWS, demo) or has not answered yet.
 */
export function UsageIndicator() {
  const { snapshot } = useUsage();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open]);

  if (!snapshot) return null;
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(event) => {
        // Tabbing out of the open panel closes it (it is a disclosure, not a modal).
        if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={`${CHIP_CLASS} ${STATE_TONE[snapshot.state]}`}
      >
        <StatusIcon state={snapshot.state} />
        {STATE_CHIP_TEXT[snapshot.state]}
      </button>
      {open && <UsagePanel id={panelId} snapshot={snapshot} onClose={close} panelRef={panelRef} />}
    </div>
  );
}
