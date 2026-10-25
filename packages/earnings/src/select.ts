/**
 * Which held symbols the watcher looks at on a run. Pure: the job loads the holdings, the states and the calendar and this decides.
 *
 * - `calendar`: the calendar expects results within [today - 3, today] and no summary is stored for that report yet: look every run.
 * - `discovery`: no calendar date is known (the calendar covers US names only, so foreign issuers have none) or the date passed without a
 *   release: look once a day.
 * - `manual`: the owner asked for this symbol.
 */
import type { EarningsHolding, EarningsSymbolState } from '@portfolio/shared';
import { daysBetween } from '@portfolio/shared';
import { addDays, utcDayOf } from './util.js';

export type CandidateMode = 'calendar' | 'discovery' | 'manual';

export interface Candidate {
  symbol: string;
  mode: CandidateMode;
}

/** Looks per symbol per UTC day (a look is one SEC request). */
export const MAX_CHECKS_PER_DAY = 30;
/** Fetch attempts (a release read with the model) per symbol per UTC day. */
export const MAX_ATTEMPTS_PER_DAY = 3;
/** A symbol the SEC did not know is looked up again after this many days. */
export const CIK_RETRY_DAYS = 30;
/** Days before a calendar date the release may already be out, and after it still looked for. */
export const WINDOW_DAYS_BEFORE = 3;
/** A filing this much older than the newest stored summary's report date is not a new quarter. */
export const NEW_QUARTER_GAP_DAYS = 5;
/** Discovery starts this many days after the newest stored release: quarterly results are about 91 days apart, so it never looks right after one. */
export const DISCOVERY_AFTER_DAYS = 60;
/** Backfill and discovery only consider filings up to this many days old (a quarter and a half). */
export const MAX_FILING_AGE_DAYS = 135;

export interface SelectInput {
  now: Date;
  /** The current date in the user's time zone (Amsterdam), YYYY-MM-DD. */
  today: string;
  holdings: readonly EarningsHolding[];
  states: ReadonlyMap<string, EarningsSymbolState>;
  /** The report date of the newest stored summary per symbol. */
  latestReport: ReadonlyMap<string, string>;
  /** Expected report dates per symbol (the calendar). */
  calendar: Readonly<Record<string, readonly string[]>>;
  /** The owner's symbol for a manual refresh. */
  manualSymbol?: string;
}

const backedOff = (state: EarningsSymbolState | undefined, now: Date): boolean => state?.retryAfter !== undefined && Date.parse(state.retryAfter) > now.getTime();

/**
 * A release found by the watcher whose summary job is queued or running: it is not looked for (and queued) again for this long. The summary
 * job is dropped (not deferred) while the budget is above 60 %, so the wait is short: the next watch finds the release again.
 */
export const PENDING_HOURS = 1;
const pending = (state: EarningsSymbolState | undefined, now: Date): boolean => state?.pendingAt !== undefined && now.getTime() - Date.parse(state.pendingAt) < PENDING_HOURS * 3_600_000;

const checksToday = (state: EarningsSymbolState | undefined, utcDay: string): number => (state?.checksDay === utcDay ? (state.checks ?? 0) : 0);

export function notInSec(state: EarningsSymbolState | undefined, today: string): boolean {
  return state?.cikMissingAt !== undefined && state.cikMissingAt.slice(0, 10) > addDays(today, -CIK_RETRY_DAYS);
}

function calendarCandidate(dates: readonly string[], today: string, latest: string | undefined): boolean {
  return dates.some((date) => date >= addDays(today, -WINDOW_DAYS_BEFORE) && date <= today && (latest === undefined || latest < addDays(date, -NEW_QUARTER_GAP_DAYS)));
}

function modeOf(input: SelectInput, holding: EarningsHolding, utcDay: string): CandidateMode | undefined {
  const { states, latestReport, calendar, today } = input;
  const state = states.get(holding.symbol);
  const latest = latestReport.get(holding.symbol);
  const dates = calendar[holding.symbol] ?? [];
  if (calendarCandidate(dates, today, latest)) return 'calendar';
  if (dates.some((date) => date > today)) return undefined;
  if (latest !== undefined && daysBetween(latest, today) < DISCOVERY_AFTER_DAYS) return undefined;
  return state?.lastCheckedAt?.slice(0, 10) === utcDay ? undefined : 'discovery';
}

/** The candidates of a run: the manual one, else calendar first, then discovery. The first quarters of every holding are the backfill job's work. */
export function selectCandidates(input: SelectInput): Candidate[] {
  const { now, holdings, states, manualSymbol } = input;
  if (manualSymbol !== undefined) {
    return holdings.some((holding) => holding.symbol === manualSymbol) ? [{ symbol: manualSymbol, mode: 'manual' }] : [];
  }
  const utcDay = utcDayOf(now);
  const picked: Candidate[] = [];
  for (const holding of holdings) {
    const state = states.get(holding.symbol);
    if (backedOff(state, now) || pending(state, now) || notInSec(state, input.today) || checksToday(state, utcDay) >= MAX_CHECKS_PER_DAY) continue;
    const mode = modeOf(input, holding, utcDay);
    if (mode !== undefined) picked.push({ symbol: holding.symbol, mode });
  }
  const rank: Record<CandidateMode, number> = { manual: 0, calendar: 1, discovery: 2 };
  return picked.toSorted((a, b) => rank[a.mode] - rank[b.mode] || a.symbol.localeCompare(b.symbol));
}
