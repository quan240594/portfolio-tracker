import { describe, expect, it } from 'vitest';
import { sampleSummary } from '@portfolio/shared';
import { FakeAi } from './testing/fake-ai.js';
import { GENERIC_RELEASE } from './testing/fixtures.js';
import { earningsHarness, type EarningsHarness } from './testing/harness.js';

const holding = { symbol: 'LMFG', name: GENERIC_RELEASE.name, template: GENERIC_RELEASE.template, currency: 'USD' } as const;

function setup(extra: Partial<Parameters<typeof earningsHarness>[0]> = {}, release = GENERIC_RELEASE, spec: { primaryDocument?: string } = {}): EarningsHarness {
  return earningsHarness({
    filings: [{ release, ...spec }],
    tickers: { LMFG: { cik: Number(release.cik), title: release.name } },
    holdings: [holding],
    calendar: { LMFG: [release.filingDate] },
    ai: new FakeAi(release.extraction),
    env: { EARNINGS_BACKFILL_QUARTERS: '1' },
    ...extra,
  });
}

const fetchRelease = async (h: EarningsHarness, primaryDocument = 'primary.htm'): Promise<void> => {
  await h.repo.patchState('LMFG', { cik: '1000101' }, h.clock.now());
  await h.queue.enqueue({ job: 'fetchEarningsSummary', payload: { symbol: 'LMFG', cik: '1000101', accession: GENERIC_RELEASE.accession, form: '8-K', filingDate: '2026-10-21', primaryDocument, origin: 'live' } });
  await h.queue.drain();
};

describe('live fetch: unusual endings', () => {
  it('a filing without any document that can be a press release is not a results release (stage exhibit)', async () => {
    const h = setup({}, { ...GENERIC_RELEASE, exhibit: 'logo.jpg' }, { primaryDocument: '' });
    await fetchRelease(h, '');
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'exhibit', detail: 'the filing has no press release document' });
  });

  it('an unexpected error is a failed fetch with the error name, not a crashed job', async () => {
    const h = setup({ estimates: { epsEstimate: () => Promise.reject(new TypeError('unexpected')) } as never });
    await fetchRelease(h);
    expect(h.queue.results.filter((entry) => entry.job === 'fetchEarningsSummary').at(-1)?.result).toEqual({ stored: false, outcome: 'failed' });
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'text', detail: 'unexpected TypeError' });
  });

  it('the host running out of subrequests asks for the step again', async () => {
    const h = setup();
    await h.repo.patchState('LMFG', { cik: '1000101' }, h.clock.now());
    h.sec.rejections.push({ needle: 'index.json', error: Object.assign(new Error('Too many subrequests'), { name: 'SubrequestLimitError' }) });
    await h.queue.enqueue({ job: 'fetchEarningsSummary', payload: { symbol: 'LMFG', cik: '1000101', accession: GENERIC_RELEASE.accession, form: '8-K', filingDate: '2026-10-21', primaryDocument: 'primary.htm', origin: 'live' } });
    await h.queue.drain();
    expect(h.queue.results.filter((entry) => entry.job === 'fetchEarningsSummary').at(-1)?.result).toEqual({ stored: true, outcome: 'stored' });
  });

  it('a summary is kept when the notification job cannot be queued', async () => {
    const h = setup();
    const enqueue = h.queue.enqueue.bind(h.queue);
    (h.deps.queue as { enqueue: unknown }).enqueue = (message: { job: string }) => (message.job === 'notifyDividends' ? Promise.reject(new Error('queue down')) : enqueue(message as never));
    await fetchRelease(h);
    expect(await h.repo.getSummary('LMFG', '2026-10-21')).not.toBeNull();
  });
});

describe('backfill: more endings', () => {
  const run = async (h: EarningsHarness): Promise<unknown> => {
    await h.queue.enqueue({ job: 'backfillEarnings', payload: { trigger: 'scheduled' } });
    await h.queue.drain();
    return h.queue.results.filter((entry) => entry.job === 'backfillEarnings').at(-1)?.result;
  };

  it('a release too big for what is left of the allowance waits for tomorrow, and the try is given back', async () => {
    const big = { ...GENERIC_RELEASE, html: GENERIC_RELEASE.html.replace('</body>', `<p>${'Additional quarterly revenue discussion and net income detail. '.repeat(800)}</p></body>`) };
    const h = setup({ allowance: 200 }, big);
    expect(await run(h)).toEqual({ status: 'waiting', waitReason: 'allowance' });
    expect((await h.repo.getState('LMFG'))!.plan![0]).toMatchObject({ status: 'todo', tries: 0 });
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'budget' });
    expect(h.ai.calls).toHaveLength(0);
  });

  it('the host running out of subrequests while the plans are made asks for the step again', async () => {
    const h = setup();
    h.sec.rejections.push({ needle: 'submissions', error: Object.assign(new Error('Too many subrequests'), { name: 'SubrequestLimitError' }) });
    expect(await run(h)).toEqual({ status: 'complete' });
    expect((await h.repo.latest('LMFG', 3)).map((summary) => summary.reportDate)).toEqual(['2026-10-21']);
  });

  it('an error that is none of the known ones is not swallowed', async () => {
    const h = setup();
    h.repo.latest = () => Promise.reject(new Error('store down'));
    await run(h);
    expect(h.queue.deadLetters).toHaveLength(1);
    expect(h.queue.deadLetters[0]!.error).toEqual(new Error('store down'));
  });

  it('a stored release makes the plan start as stored and the run ends complete at once', async () => {
    const h = setup();
    await h.repo.putSummary(sampleSummary({ symbol: 'LMFG', reportDate: '2026-10-21', accession: GENERIC_RELEASE.accession }));
    expect(await run(h)).toEqual({ status: 'complete' });
    expect(h.ai.calls).toHaveLength(0);
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'ok', detail: '1 quarter(s) already stored' });
  });
});
