import { describe, expect, it } from 'vitest';
import type { EarningsLastRun, EarningsStatusResponse, EarningsSymbolStatus } from '@portfolio/shared';
import { backfillText, checkedLine, checkedLines, lastPassText, notCountedText, totalsText } from './checked';

const filing = { form: '8-K', date: '2026-10-29', accession: '0001-26-1' };
const run = (stage: EarningsLastRun['stage'], detail?: string, withFiling = true): EarningsLastRun => ({ at: '2026-10-29T06:30:00.000Z', stage, ...(detail === undefined ? {} : { detail }), ...(withFiling ? { filing } : {}) });
const entry = (symbol: string, lastRun?: EarningsLastRun, extra: Partial<EarningsSymbolStatus> = {}): EarningsSymbolStatus => ({ symbol, eligible: true, ...(lastRun === undefined ? {} : { lastRun }), ...extra });
const status = (patch: Partial<EarningsStatusResponse> = {}): EarningsStatusResponse => ({ available: true, configured: true, missing: [], estimatesConfigured: false, symbols: [], ...patch });

describe('one line per company', () => {
  it.each([
    ['ok', run('ok', 'summary stored'), 'MSFT: found 8-K from 29-10-2026, summary stored', 'ok'],
    ['ok without a filing', run('ok', 'nothing newer than the stored release', false), 'MSFT: nothing newer than the stored release', 'ok'],
    ['ok with nothing said', run('ok', undefined, false), 'MSFT: up to date', 'ok'],
    ['select-filing', run('select-filing'), 'MSFT: found 8-K from 29-10-2026, reading it', 'wait'],
    ['ticker-map', run('ticker-map', 'not found in the SEC company list', false), 'MSFT: not found in the SEC company list', 'problem'],
    ['ticker-map without a detail', run('ticker-map', undefined, false), 'MSFT: not found in the SEC company list', 'problem'],
    ['submissions', run('submissions', 'The submissions list: the SEC answered 500', false), 'MSFT: the SEC list of filings could not be read (The submissions list: the SEC answered 500)', 'problem'],
    ['exhibit', run('exhibit', 'the filing has no press release document'), 'MSFT: found 8-K from 29-10-2026, its press release could not be read (the filing has no press release document)', 'problem'],
    ['text', run('text', '2 document(s) read, none reads like a results release'), 'MSFT: found 8-K from 29-10-2026, 2 document(s) read, none reads like a results release', 'problem'],
    ['text without a detail', run('text'), 'MSFT: found 8-K from 29-10-2026, it did not read like a results release', 'problem'],
    ['ai', run('ai', 'invalid JSON'), 'MSFT: found 8-K from 29-10-2026, the AI could not read it (invalid JSON)', 'problem'],
    ['ai without a detail', run('ai'), 'MSFT: found 8-K from 29-10-2026, the AI could not read it', 'problem'],
    ['verify', run('verify', 'no headline figure was found in the text (3 dropped)'), "MSFT: found 8-K from 29-10-2026, none of the AI's figures could be found in the text (no headline figure was found in the text (3 dropped))", 'problem'],
    ['store', run('store', 'disk full'), 'MSFT: found 8-K from 29-10-2026, the summary could not be stored (disk full)', 'problem'],
    ['budget', run('budget'), 'MSFT: found 8-K from 29-10-2026, waiting for the daily AI allowance (resumes after 00:00 UTC)', 'wait'],
    ['sec-blocked', run('sec-blocked', undefined, false), 'MSFT: the SEC asked us to slow down', 'wait'],
    ['not-eligible', run('not-eligible', undefined, false), 'MSFT: no quarterly results', 'ok'],
    ['no-release-found', run('no-release-found', undefined, false), 'MSFT: no results release found', 'problem'],
  ] as const)('%s', (_name, lastRun, text, tone) => {
    expect(checkedLine(entry('MSFT', lastRun), status())).toEqual({ symbol: 'MSFT', text, tone });
  });

  it('names the end of an SEC block and the quarters of the plan', () => {
    const blocked = checkedLine(entry('JPM', run('sec-blocked', undefined, false)), status({ secBlockedUntil: '2026-10-29T09:30:00.000Z' }));
    expect(blocked.text).toMatch(/^JPM: blocked by the SEC until 29-10-2026, \d\d:\d\d$/);
    expect(checkedLine(entry('A', run('ok', 'summary stored'), { releases: { planned: 4, stored: 3, failed: 0 } }), status()).text).toBe('A: found 8-K from 29-10-2026, summary stored · 3 of 4 quarters stored');
    expect(checkedLine(entry('A', run('ok', 'summary stored'), { releases: { planned: 0, stored: 0, failed: 0 } }), status()).text).toBe('A: found 8-K from 29-10-2026, summary stored');
  });

  it('falls back to the older fields when a deployment has no run yet', () => {
    expect(checkedLine(entry('A'), status()).text).toBe('A: not checked yet');
    expect(checkedLine(entry('A', undefined, { lastCheckedAt: '2026-10-29T06:30:00.000Z', lastResult: 'ok' }), status())).toMatchObject({ tone: 'ok' });
    expect(checkedLine(entry('A', undefined, { lastCheckedAt: '2026-10-29T06:30:00.000Z', lastResult: 'failed', lastReason: 'boom' }), status())).toMatchObject({ tone: 'wait', text: expect.stringContaining(', boom') });
  });

  it('lists only the eligible companies, or the selected one', () => {
    const all = status({ symbols: [entry('A', run('ok')), entry('B', run('ai')), { symbol: 'FUND', eligible: false }] });
    expect(checkedLines(all).map((line) => line.symbol)).toEqual(['A', 'B']);
    expect(checkedLines(all, 'B').map((line) => line.symbol)).toEqual(['B']);
  });
});

describe('totals and the last full pass', () => {
  it('counts holdings, companies, summaries and instruments without results', () => {
    expect(totalsText(status({ symbols: [entry('A', undefined, { latestReportDate: '2026-10-01' }), entry('B'), { symbol: 'F', eligible: false }] }))).toBe('3 holdings · 2 companies · 1 with a summary · 1 without quarterly results (funds, crypto, ...)');
    expect(totalsText(status({ symbols: [entry('A')] }))).toBe('1 holdings · 1 companies · 0 with a summary');
  });

  it('says how many symbols are not counted because they are no longer held, only when there are any', () => {
    expect(notCountedText(status())).toBeUndefined();
    expect(notCountedText(status({ notHeld: 0 }))).toBeUndefined();
    expect(notCountedText(status({ notHeld: 1 }))).toBe('Not counted: 1 symbol you no longer hold.');
    expect(notCountedText(status({ notHeld: 94 }))).toBe('Not counted: 94 symbols you no longer hold.');
  });

  it('says when every company was looked at, or that not all were', () => {
    expect(lastPassText(status())).toBe('Last full pass: not every company has been looked at yet.');
    expect(lastPassText(status({ lastFullPassAt: '2026-10-29T06:30:00.000Z' }))).toMatch(/^Last full pass: every company was looked at since 29-10-2026, \d\d:\d\d\.$/);
  });
});

describe('backfillText', () => {
  const base = { quarters: 4, total: 80, done: 34, stored: 30, failed: 0, planned: 20, companies: 20 };

  it('is absent without a status and says the start is near before the first step', () => {
    expect(backfillText(undefined)).toBeUndefined();
    expect(backfillText({ ...base, status: 'not-started' })).toEqual({ headline: expect.stringContaining('within 15 minutes') });
  });

  it('says a rescan is starting while nothing is planned yet', () => {
    expect(backfillText({ ...base, status: 'running', total: 0, done: 0, stored: 0, planned: 0, companies: 0 })).toEqual({ headline: expect.stringContaining('Rescanning every holding'), detail: 'Working on it: a step runs every 15 minutes.' });
  });

  it('shows the progress with the reason and the time of a pause', () => {
    const until = '2026-10-30T00:05:00.000Z';
    expect(backfillText({ ...base, status: 'running', waitReason: 'allowance', waitUntil: until })).toMatchObject({ headline: '34 of 80 releases read.', progress: { done: 34, total: 80 }, detail: expect.stringMatching(/^Resumes at 00:00 UTC \(30-10-2026, \d\d:\d\d your time\) when the daily AI allowance is used up\.$/) });
    for (const [reason, text] of [['sec-blocked', 'Paused until'], ['sec-error', 'did not answer properly'], ['attempts', 'tried today'], ['ai-error', 'AI answered with errors']] as const) {
      expect(backfillText({ ...base, status: 'running', waitReason: reason, waitUntil: until })?.detail).toContain(text);
    }
    expect(backfillText({ ...base, status: 'running' })?.detail).toBe('Working on it: a step runs every 15 minutes.');
  });

  it('counts the failed releases and the companies not listed yet', () => {
    expect(backfillText({ ...base, status: 'running', failed: 3, planned: 18 })?.headline).toBe('34 of 80 releases read (3 could not be read). The SEC list of 2 of 20 companies is not read yet.');
  });

  it('says when it finished', () => {
    expect(backfillText({ ...base, status: 'complete', done: 80, completedAt: '2026-10-30T08:00:00.000Z' })?.headline).toMatch(/^80 of 80 releases read, finished on 30-10-2026, \d\d:\d\d\.$/);
    expect(backfillText({ ...base, status: 'complete', done: 80 })?.headline).toBe('80 of 80 releases read, finished.');
  });
});
