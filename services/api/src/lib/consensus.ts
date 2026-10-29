import { logger } from '@portfolio/platform';
import { attachConsensus, type CalendarEstimate, type EarningsSummary } from '@portfolio/shared';
import type { Repository } from '../repository.js';

/** The calendar is read this many days around the summaries: the report date and the calendar's date of a release differ by a few days. */
const CALENDAR_SLACK_DAYS = 5;
const DAY_MS = 86_400_000;

const shiftDay = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const byText = (a: string, b: string): number => a.localeCompare(b);

/**
 * The summaries with the analyst consensus joined (`attachConsensus`): the stored consensus of each symbol, and the calendar's EPS estimate where
 * there is no consensus. A failure to read either leaves the summaries as they are: the page works without estimates.
 */
export async function withConsensus(repo: Pick<Repository, 'getConsensus' | 'getConsensusEndpoint' | 'getCalendarEvents'>, summaries: readonly EarningsSummary[], keyed = true): Promise<EarningsSummary[]> {
  if (summaries.length === 0) return [];
  const symbols = [...new Set(summaries.map((summary) => summary.symbol))];
  const dates = [...summaries.map((summary) => summary.reportDate)].sort(byText);
  try {
    const [stored, endpoint, events] = await Promise.all([
      Promise.all(symbols.map((symbol) => repo.getConsensus(symbol))),
      repo.getConsensusEndpoint(),
      repo.getCalendarEvents(symbols, shiftDay(dates[0]!, -CALENDAR_SLACK_DAYS), shiftDay(dates.at(-1)!, CALENDAR_SLACK_DAYS)),
    ]);
    const consensus = new Map(symbols.map((symbol, index) => [symbol, stored[index]!]));
    return summaries.map((summary) => {
      const calendar: CalendarEstimate[] = events.earnings.filter((event) => event.symbol === summary.symbol);
      return attachConsensus(summary, { ...consensus.get(summary.symbol)!, calendar, keyed, endpoint });
    });
  } catch (error) {
    logger.warn('Could not join the consensus estimates', { error: error instanceof Error ? error.name : 'unknown' });
    return [...summaries];
  }
}
