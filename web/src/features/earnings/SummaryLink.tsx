import { Link } from 'react-router-dom';
import { daysBetween } from '@portfolio/shared';
import { useEarnings, useEarningsStatus } from '../../api/earningsHooks';

/** How far from the expected date of a calendar entry a stored report date may be and still be "its" summary (companies report a few days off). */
const MATCH_DAYS = 10;

/**
 * "View summary" for an earnings event of the calendar: shown only when the feature is on and a summary of the symbol was released around that
 * date, so the link never leads to an empty page.
 */
export function SummaryLink({ symbol, date, onNavigate }: Readonly<{ symbol: string; date: string; onNavigate?: () => void }>) {
  const status = useEarningsStatus();
  const available = status.data?.available === true && status.data.configured;
  const list = useEarnings({ symbol, limit: 8 }, { enabled: available });
  const found = list.data?.summaries.some((summary) => Math.abs(daysBetween(summary.reportDate, date)) <= MATCH_DAYS);
  if (!available || !found) return null;
  return (
    <Link to={`/earnings/${encodeURIComponent(symbol)}`} className="btn-secondary" onClick={onNavigate}>
      View summary
    </Link>
  );
}
