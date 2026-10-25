import { describe, expect, it } from 'vitest';
import type { EarningsHolding } from '@portfolio/shared';
import { FakeAi, type AiCall } from './testing/fake-ai.js';
import type { FilingSpec } from './testing/fake-sec.js';
import { GENERIC_RELEASE, REIT_RELEASE, type FixtureRelease } from './testing/fixtures.js';
import { earningsHarness, type EarningsHarness, type HarnessOptions } from './testing/harness.js';
import { FOREIGN_TEXT_RELEASE } from './testing/messy-fixtures.js';

const holding = (release: FixtureRelease): EarningsHolding => ({ symbol: release.symbol, name: release.name, template: release.template, currency: 'USD' });

function quarterly(release: FixtureRelease, dates: readonly string[]): FilingSpec[] {
  return dates.map((date, index) => ({ release: { ...release, filingDate: date, accession: `${release.accession.slice(0, 14)}${String(900 + index).padStart(6, '0')}` } }));
}

function setup(releases: FixtureRelease[], options: HarnessOptions = {}): EarningsHarness {
  return earningsHarness({
    filings: releases.flatMap((release) => quarterly(release, ['2026-10-14', '2026-07-15'])),
    tickers: Object.fromEntries(releases.map((release) => [release.symbol.split('.')[0]!, { cik: Number(release.cik), title: release.name }])),
    holdings: releases.map(holding),
    ai: new FakeAi((call: AiCall) => releases.find((release) => call.input.messages[1]!.content.includes(`Company: ${release.name}`))?.extraction),
    env: { EARNINGS_BACKFILL_QUARTERS: '2' },
    ...options,
  });
}

async function run(h: EarningsHarness): Promise<void> {
  await h.queue.enqueue({ job: 'backfillEarnings', payload: { trigger: 'scheduled' } });
  await h.queue.drain();
}

const last = (h: EarningsHarness) => h.queue.results.filter((entry) => entry.job === 'backfillEarnings').at(-1)?.result;

describe('backfill: things that go wrong in the middle', () => {
  it('a failing submissions list is a failed plan with the reason, made again after a day', async () => {
    const h = setup([GENERIC_RELEASE]);
    h.sec.statusFor.set('/submissions/', 500);
    await run(h);
    expect(await h.repo.getState('LMFG')).toMatchObject({ plan: [], lastRun: { stage: 'submissions', detail: 'The submissions list: the SEC answered 500' } });
    expect(last(h)).toEqual({ status: 'complete' });
    h.sec.statusFor.clear();
    await h.repo.putBackfill({ ...(await h.repo.getBackfill())!, status: 'running' });
    h.clock.advance(25 * 3_600_000);
    await run(h);
    expect((await h.repo.latest('LMFG', 5)).map((summary) => summary.reportDate)).toEqual(['2026-10-14', '2026-07-15']);
  });

  it('an unreadable ticker list pauses the run for half an hour, it does not fail the job', async () => {
    const h = setup([GENERIC_RELEASE]);
    h.sec.statusFor.set('company_tickers', 500);
    await run(h);
    expect(last(h)).toEqual({ status: 'waiting', waitReason: 'sec-error' });
    expect(await h.repo.getBackfill()).toMatchObject({ waitReason: 'sec-error' });
  });

  it('a block while a release is read pauses the run until the block ends and gives the try back', async () => {
    const h = setup([GENERIC_RELEASE]);
    h.sec.statusFor.set('index.json', 429);
    await run(h);
    expect(last(h)).toEqual({ status: 'waiting', waitReason: 'sec-blocked' });
    expect((await h.repo.getState('LMFG'))!.plan![0]).toMatchObject({ status: 'todo', tries: 0, triesToday: 0 });
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'sec-blocked' });
  });

  it('a block recorded by another job is honoured by the first step', async () => {
    const h = setup([GENERIC_RELEASE]);
    await h.repo.putSecBlock({ blockedUntil: '2026-10-22T00:00:00.000Z', failures: 1, lastStatus: 429, updatedAt: h.clock.now().toISOString() });
    await run(h);
    expect(last(h)).toEqual({ status: 'waiting', waitReason: 'sec-blocked' });
    expect(await h.repo.getBackfill()).toMatchObject({ waitUntil: '2026-10-22T00:00:00.000Z' });
    expect(h.sec.requests).toHaveLength(0);
  });

  it('the host running out of subrequests continues the run in the next alarm without losing the try', async () => {
    const h = setup([GENERIC_RELEASE]);
    h.sec.rejections.push({ needle: 'index.json', error: Object.assign(new Error('Too many subrequests'), { name: 'SubrequestLimitError' }) });
    await run(h);
    expect(last(h)).toEqual({ status: 'complete' });
    expect((await h.repo.latest('LMFG', 5)).map((summary) => summary.reportDate)).toEqual(['2026-10-14', '2026-07-15']);
    expect((await h.repo.getState('LMFG'))!.plan!.map((item) => item.tries)).toEqual([1, 1]);
  });

  it('a filing index that is not there (yet) is retried later, with the reason, not skipped for good', async () => {
    const h = setup([GENERIC_RELEASE]);
    h.sec.statusFor.set('index.json', 404);
    await run(h);
    expect((await h.repo.getState('LMFG'))!.plan![0]).toMatchObject({ status: 'todo', tries: 1, reason: 'The filing index was not found at the SEC' });
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'exhibit', detail: 'The filing index was not found at the SEC' });
  });

  it('an SEC error while reading is retried after a pause and failed after four tries; three errors in a row pause the whole run', async () => {
    const h = setup([GENERIC_RELEASE, REIT_RELEASE]);
    h.sec.statusFor.set('index.json', 500);
    await run(h);
    expect(last(h)).toEqual({ status: 'waiting', waitReason: 'ai-error' });
    expect((await h.repo.getState('LMFG'))!.plan![0]).toMatchObject({ status: 'todo', tries: 1, reason: 'The filing index: the SEC answered 500' });
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'exhibit' });
  });

  it('an unexpected error is a failed release, not a crashed job', async () => {
    const estimates = { epsEstimate: () => Promise.reject(new TypeError('unexpected')) };
    const h = setup([GENERIC_RELEASE], { estimates: estimates as never, filings: quarterly(GENERIC_RELEASE, ['2026-10-21', '2026-07-15']) });
    await run(h);
    expect((await h.repo.getState('LMFG'))!.plan![0]).toMatchObject({ status: 'todo', tries: 1, reason: 'unexpected TypeError' });
    expect((await h.repo.latest('LMFG', 5)).map((summary) => summary.reportDate)).toEqual(['2026-07-15']);
  });

  it('a release stored by the live watcher meanwhile is not read again', async () => {
    const h = setup([GENERIC_RELEASE]);
    const step = h.registry.backfillEarnings!;
    let cursor: string | undefined;
    for (let guard = 0; guard < 10 && (await h.repo.getState('LMFG'))?.plan === undefined; guard++) {
      const result = await step({ payload: { trigger: 'scheduled' }, cursor });
      cursor = result.done ? undefined : result.next;
    }
    expect((await h.repo.getState('LMFG'))!.plan).toHaveLength(2);
    await h.repo.putSummary({ ...(await import('@portfolio/shared')).sampleSummary({ symbol: 'LMFG', reportDate: '2026-10-14', accession: 'live-one' }) });
    const calls = h.ai.calls.length;
    await run(h);
    expect(h.ai.calls.length - calls).toBe(1);
    expect((await h.repo.getState('LMFG'))!.plan!.map((item) => item.status)).toEqual(['stored', 'stored']);
  });

  it('a company with 6-Ks only that are no results release says so once all were looked at', async () => {
    const notice = (accession: string, date: string): FilingSpec => ({ release: { ...FOREIGN_TEXT_RELEASE, accession, filingDate: date, html: '<p>Notice of the annual general meeting of shareholders. Please vote.</p>' } });
    const h = earningsHarness({
      filings: [notice('0001000703-26-000120', '2026-10-20'), notice('0001000703-26-000110', '2026-09-01')],
      tickers: { DSVX: { cik: 1000703, title: 'Delft Semiconductor Systems N.V.' } },
      holdings: [holding(FOREIGN_TEXT_RELEASE)],
      env: { EARNINGS_BACKFILL_QUARTERS: '2' },
    });
    await run(h);
    expect((await h.repo.getState('DSVX.AS'))!.lastRun).toMatchObject({ stage: 'no-release-found', detail: '2 filing(s) looked at, none was a results release' });
    expect(h.ai.calls).toHaveLength(0);
    expect(await h.repo.getBackfill()).toMatchObject({ status: 'complete', total: 0, done: 0, planned: 1 });
  });

  it('asks for the EPS estimate only for the release that notifies, so the shared Alpha Vantage quota survives the backfill', async () => {
    const asked: string[] = [];
    const estimates = { epsEstimate: (symbol: string, date: string) => (asked.push(`${symbol} ${date}`), Promise.resolve({ status: 'no-entry' as const })) };
    const h = setup([GENERIC_RELEASE], { estimates, filings: quarterly(GENERIC_RELEASE, ['2026-10-21', '2026-07-15']) });
    await run(h);
    expect(asked).toEqual(['LMFG 2026-10-21']);
  });

  it('stops after the most steps one run may take', async () => {
    const h = setup([GENERIC_RELEASE]);
    const step = h.registry.backfillEarnings!;
    const result = await step({ payload: { trigger: 'scheduled' }, cursor: JSON.stringify({ steps: 399, errors: 0 }) });
    expect(result).toEqual({ done: true, result: { status: 'stopped' } });
  });
});
