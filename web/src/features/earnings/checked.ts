/**
 * What the Earnings page says about the checks, as plain data: one human line per held company (the stage the last run ended in and why),
 * the totals, the last full pass and the progress of the backfill. Dates are dd-mm-yyyy through the app helpers.
 */
import type { EarningsBackfillStatus, EarningsLastRun, EarningsStatusResponse, EarningsSymbolStatus } from '@portfolio/shared';
import { formatDate, formatDateTime } from '../../lib/format';

export interface CheckedLine {
  symbol: string;
  text: string;
  /** `problem` is a stage where the pipeline stopped before a summary; the page draws it with the warning colour. */
  tone: 'ok' | 'wait' | 'problem';
}

const findingOf = (run: EarningsLastRun): string => (run.filing === undefined ? 'a release' : `${run.filing.form} from ${formatDate(run.filing.date)}`);
const inBrackets = (detail: string | undefined): string => (detail === undefined || detail === '' ? '' : ` (${detail})`);

type Phrase = (run: EarningsLastRun, status: EarningsStatusResponse) => { text: string; tone: CheckedLine['tone'] };

const PHRASES: Readonly<Record<EarningsLastRun['stage'], Phrase>> = {
  ok: (run) => ({ text: run.filing === undefined ? (run.detail ?? 'up to date') : `found ${findingOf(run)}, ${run.detail ?? 'summary stored'}`, tone: 'ok' }),
  'select-filing': (run) => ({ text: `found ${findingOf(run)}, ${run.detail ?? 'reading it'}`, tone: 'wait' }),
  'ticker-map': (run) => ({ text: `${run.detail ?? 'not found in the SEC company list'}`, tone: 'problem' }),
  submissions: (run) => ({ text: `the SEC list of filings could not be read${inBrackets(run.detail)}`, tone: 'problem' }),
  exhibit: (run) => ({ text: `found ${findingOf(run)}, its press release could not be read${inBrackets(run.detail)}`, tone: 'problem' }),
  text: (run) => ({ text: `found ${findingOf(run)}, ${run.detail ?? 'it did not read like a results release'}`, tone: 'problem' }),
  ai: (run) => ({ text: `found ${findingOf(run)}, the AI could not read it${inBrackets(run.detail)}`, tone: 'problem' }),
  verify: (run) => ({ text: `found ${findingOf(run)}, none of the AI's figures could be found in the text${inBrackets(run.detail)}`, tone: 'problem' }),
  store: (run) => ({ text: `found ${findingOf(run)}, the summary could not be stored${inBrackets(run.detail)}`, tone: 'problem' }),
  budget: (run) => ({ text: `found ${findingOf(run)}, waiting for the daily AI allowance (resumes after 00:00 UTC)`, tone: 'wait' }),
  'sec-blocked': (_run, status) => ({ text: status.secBlockedUntil === undefined ? 'the SEC asked us to slow down' : `blocked by the SEC until ${formatDateTime(status.secBlockedUntil)}`, tone: 'wait' }),
  'not-eligible': (run) => ({ text: run.detail ?? 'no quarterly results', tone: 'ok' }),
  'no-release-found': (run) => ({ text: run.detail ?? 'no results release found', tone: 'problem' }),
};

function releasesNote(entry: EarningsSymbolStatus): string {
  if (entry.releases === undefined || entry.releases.planned === 0) return '';
  const failed = entry.releases.failed > 0 ? `, ${entry.releases.failed} could not be read` : '';
  return ` · ${entry.releases.stored} of ${entry.releases.planned} quarters stored${failed}`;
}

/** The line of one company. Without a run (an older deployment, or never checked) the older fields say what they can. */
export function checkedLine(entry: EarningsSymbolStatus, status: EarningsStatusResponse): CheckedLine {
  if (entry.lastRun !== undefined) {
    const phrase = PHRASES[entry.lastRun.stage](entry.lastRun, status);
    return { symbol: entry.symbol, text: `${entry.symbol}: ${phrase.text}${releasesNote(entry)}`, tone: phrase.tone };
  }
  if (!entry.lastCheckedAt) return { symbol: entry.symbol, text: `${entry.symbol}: not checked yet`, tone: 'wait' };
  const reason = entry.lastReason ? `, ${entry.lastReason}` : '';
  return { symbol: entry.symbol, text: `${entry.symbol}: checked ${formatDateTime(entry.lastCheckedAt)}${reason}`, tone: entry.lastResult === 'ok' ? 'ok' : 'wait' };
}

export function checkedLines(status: EarningsStatusResponse, selected?: string): CheckedLine[] {
  return status.symbols
    .filter((entry) => entry.eligible && (selected === undefined || entry.symbol === selected))
    .map((entry) => checkedLine(entry, status));
}

/** `26 holdings: 20 companies read, 14 with a summary, 6 without quarterly results (funds, crypto, ...).` */
export function totalsText(status: EarningsStatusResponse): string {
  const eligible = status.symbols.filter((entry) => entry.eligible);
  const withSummary = eligible.filter((entry) => entry.latestReportDate !== undefined).length;
  const others = status.symbols.length - eligible.length;
  const parts = [`${status.symbols.length} holdings`, `${eligible.length} companies`, `${withSummary} with a summary`];
  if (others > 0) parts.push(`${others} without quarterly results (funds, crypto, ...)`);
  return parts.join(' · ');
}

/** `Not counted: 94 symbols you no longer hold.`; absent when there are none. */
export function notCountedText(status: EarningsStatusResponse): string | undefined {
  const count = status.notHeld ?? 0;
  return count > 0 ? `Not counted: ${count} symbol${count === 1 ? '' : 's'} you no longer hold.` : undefined;
}

export function lastPassText(status: EarningsStatusResponse): string {
  return status.lastFullPassAt === undefined ? 'Last full pass: not every company has been looked at yet.' : `Last full pass: every company was looked at since ${formatDateTime(status.lastFullPassAt)}.`;
}

const WAIT_TEXT: Readonly<Record<NonNullable<EarningsBackfillStatus['waitReason']>, (until: string) => string>> = {
  allowance: (until) => `Resumes at 00:00 UTC (${formatDateTime(until)} your time) when the daily AI allowance is used up.`,
  'sec-blocked': (until) => `Paused until ${formatDateTime(until)}: the SEC asked us to slow down.`,
  'sec-error': (until) => `The SEC did not answer properly. Trying again after ${formatDateTime(until)}.`,
  attempts: (until) => `Releases that were tried today are tried again after ${formatDateTime(until)}.`,
  'ai-error': (until) => `The AI answered with errors. Trying again after ${formatDateTime(until)}.`,
};

export interface BackfillText {
  headline: string;
  detail?: string;
  /** Releases read and wanted, for the progress bar; absent when nothing is planned yet. */
  progress?: { done: number; total: number };
}

/** `34 of 80 releases read` and why it waits, in words. */
export function backfillText(backfill: EarningsBackfillStatus | undefined): BackfillText | undefined {
  if (backfill === undefined) return undefined;
  if (backfill.status === 'not-started') return { headline: 'The latest quarters of every holding are read in the background: the first step starts within 15 minutes.' };
  if (backfill.status === 'running' && backfill.total === 0 && backfill.planned === 0) return { headline: 'Rescanning every holding: the current holdings are listed again, the first step starts within 15 minutes.', detail: 'Working on it: a step runs every 15 minutes.' };
  const failed = backfill.failed > 0 ? ` (${backfill.failed} could not be read)` : '';
  const listed = backfill.planned < backfill.companies ? ` The SEC list of ${backfill.companies - backfill.planned} of ${backfill.companies} companies is not read yet.` : '';
  if (backfill.status === 'complete') {
    const when = backfill.completedAt === undefined ? '' : ` on ${formatDateTime(backfill.completedAt)}`;
    return { headline: `${backfill.done} of ${backfill.total} releases read${failed}, finished${when}.`, progress: { done: backfill.done, total: backfill.total } };
  }
  const wait = backfill.waitReason !== undefined && backfill.waitUntil !== undefined ? WAIT_TEXT[backfill.waitReason](backfill.waitUntil) : undefined;
  return {
    headline: `${backfill.done} of ${backfill.total} releases read${failed}.${listed}`,
    ...(wait === undefined ? { detail: 'Working on it: a step runs every 15 minutes.' } : { detail: wait }),
    progress: { done: backfill.done, total: backfill.total },
  };
}
