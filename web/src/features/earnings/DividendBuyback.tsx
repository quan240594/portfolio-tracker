import { capitalReturnLines, type CapitalReturnIcon } from './dividendModel';
import type { EarningsSummary } from '@portfolio/shared';

const ICON_PATHS: Readonly<Record<CapitalReturnIcon, string>> = {
  up: 'M10 16V4M5 9l5-5 5 5',
  down: 'M10 4v12M5 11l5 5 5-5',
  same: 'M4 7h12M4 13h12',
  new: 'M10 4v12M4 10h12',
  stop: 'M5 5l10 10M15 5L5 15',
};

/** An arrow, bar or cross that goes with the words: the change is never told by colour alone. */
function Icon({ icon }: Readonly<{ icon: CapitalReturnIcon }>) {
  return (
    <svg aria-hidden="true" data-icon={icon} viewBox="0 0 20 20" className="mr-1 inline h-4 w-4 align-text-bottom" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICON_PATHS[icon]} />
    </svg>
  );
}

/**
 * The dividend and the share buybacks announced with the results, right after the headline figures: both lines always (N/A when the release
 * announces none), or one line that says the summary has not been read for them yet.
 */
export function CapitalReturn({ summary }: Readonly<{ summary: EarningsSummary }>) {
  const lines = capitalReturnLines(summary);
  return (
    <ul className="mt-3 space-y-1 text-sm" aria-label="Dividend and share buybacks">
      {lines.map((line) => (
        <li key={line.key} className={line.tone === 'unread' || line.tone === 'none' ? 'muted' : undefined} data-tone={line.tone}>
          <strong className="font-semibold">{line.label}:</strong>{' '}
          {line.icon && <Icon icon={line.icon} />}
          <span className="break-words">{line.text}</span>
          {line.note && <span className="muted text-xs"> · {line.note}</span>}
        </li>
      ))}
    </ul>
  );
}
