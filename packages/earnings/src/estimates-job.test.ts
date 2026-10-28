import { describe, expect, it } from 'vitest';
import type { EstimatesAnswer } from '@portfolio/prices';
import { sampleSummary, type ConsensusQuarter, type ConsensusState, type EarningsHolding, type EarningsSummary } from '@portfolio/shared';
import { ESTIMATES_CALLS_PER_RUN, estimateTier, planEstimates, type EstimateSubject } from './estimates-job.js';
import { FakeEstimates, SAMPLE_ESTIMATES } from './testing/fake-estimates.js';
import { earningsHarness, NOW, type EarningsHarness } from './testing/harness.js';

const DAY = 86_400_000;
const symbols = (count: number): EarningsHolding[] => Array.from({ length: count }, (_, index) => ({ symbol: `S${String.fromCharCode(65 + index)}`, name: `Company ${index}`, template: 'generic' as const }));
const iso = (ms: number): string => new Date(ms).toISOString();
const ago = (days: number): string => iso(NOW.getTime() - days * DAY);

const state = (extra: Partial<ConsensusState> = {}): ConsensusState => ({ symbol: 'SA', outcome: 'ok', at: ago(1), fetchedAt: ago(1), ticker: 'SA', updatedAt: ago(1), ...extra });
const quarter = (quarterEnd: string): ConsensusQuarter => ({ symbol: 'SA', quarterEnd, ticker: 'SA', fetchedAt: ago(1), eps: { average: 1 } });
const latest = (extra: Partial<EarningsSummary> = {}): EarningsSummary => sampleSummary({ symbol: 'SA', reportDate: '2026-10-21', generatedAt: ago(0), origin: 'backfill', ...extra });
const subject = (extra: Partial<EstimateSubject> = {}): EstimateSubject => ({ symbol: 'SA', state: null, quarters: [], dates: [], ...extra });

describe('estimateTier: who is due', () => {
  it('asks first for a company whose newest summary has no consensus (tier 0), and again after a failed attempt has cooled down', () => {
    expect(estimateTier(subject({ latest: latest() }), NOW)).toBe(0);
    expect(estimateTier(subject({ latest: latest(), state: state({ outcome: 'error', at: ago(0.1) }) }), NOW)).toBeUndefined();
    expect(estimateTier(subject({ latest: latest(), state: state({ outcome: 'error', at: ago(0.5) }) }), NOW)).toBe(0);
  });

  it('leaves a fetch that matched nothing alone for three days', () => {
    expect(estimateTier(subject({ latest: latest(), state: state({ at: ago(2) }) }), NOW)).toBeUndefined();
    expect(estimateTier(subject({ latest: latest(), state: state({ at: ago(4) }) }), NOW)).toBe(0);
  });

  it('leaves a company without coverage for 30 days and one that needs a premium plan for a week', () => {
    expect(estimateTier(subject({ latest: latest(), state: state({ outcome: 'no-coverage', at: ago(29) }) }), NOW)).toBeUndefined();
    expect(estimateTier(subject({ latest: latest(), state: state({ outcome: 'no-coverage', at: ago(31) }) }), NOW)).toBe(0);
    expect(estimateTier(subject({ latest: latest(), state: state({ outcome: 'premium', at: ago(6) }) }), NOW)).toBeUndefined();
    expect(estimateTier(subject({ latest: latest(), state: state({ outcome: 'premium', at: ago(8) }) }), NOW)).toBe(0);
    expect(estimateTier(subject({ state: state({ outcome: 'rate-limited', at: ago(0.2) }) }), NOW)).toBeUndefined();
  });

  it('treats a company that reports within three days, or reported in the last three, as tier 1, once the figures are three days old', () => {
    const matched = { latest: latest(), quarters: [quarter('2026-09-30')] };
    expect(estimateTier(subject({ ...matched, state: state({ fetchedAt: ago(5) }), dates: ['2026-10-23'] }), NOW)).toBe(1);
    expect(estimateTier(subject({ ...matched, state: state({ fetchedAt: ago(5) }), dates: ['2026-10-19'] }), NOW)).toBe(1);
    expect(estimateTier(subject({ ...matched, state: state({ fetchedAt: ago(2) }), dates: ['2026-10-23'] }), NOW)).toBeUndefined();
    expect(estimateTier(subject({ ...matched, state: state({ fetchedAt: ago(5) }), dates: ['2026-10-30'] }), NOW)).toBeUndefined();
  });

  it('treats a live release newer than the figures as tier 1, a backfilled one as nothing new', () => {
    const matched = { quarters: [quarter('2026-09-30')], state: state({ fetchedAt: ago(5) }) };
    expect(estimateTier(subject({ ...matched, latest: latest({ origin: 'live', generatedAt: ago(0) }) }), NOW)).toBe(1);
    expect(estimateTier(subject({ ...matched, latest: latest({ origin: 'backfill', generatedAt: ago(0) }) }), NOW)).toBeUndefined();
    expect(estimateTier(subject({ ...matched, latest: latest({ origin: 'live', generatedAt: ago(9) }) }), NOW)).toBeUndefined();
  });

  it('refreshes the rest every 14 days at most (tier 2), and fetches a company without any figures or summary', () => {
    const matched = { latest: latest(), quarters: [quarter('2026-09-30')] };
    expect(estimateTier(subject({ ...matched, state: state({ fetchedAt: ago(13) }) }), NOW)).toBeUndefined();
    expect(estimateTier(subject({ ...matched, state: state({ fetchedAt: ago(14) }) }), NOW)).toBe(2);
    expect(estimateTier(subject(), NOW)).toBe(2);
    expect(estimateTier(subject({ state: state({ outcome: 'error', at: ago(1), fetchedAt: undefined }) }), NOW)).toBe(2);
  });
});

describe('planEstimates: in which order', () => {
  it('puts tier 0 before tier 1 before tier 2, then the longest ago, never attempted first, then by name', () => {
    const matched = (symbol: string, extra: Partial<EstimateSubject>): EstimateSubject => subject({ symbol, latest: latest({ symbol }), quarters: [{ ...quarter('2026-09-30'), symbol }], ...extra });
    const plan = planEstimates(
      [
        matched('SS', { state: state({ symbol: 'SS', fetchedAt: ago(20), at: ago(20) }) }),
        matched('SR', { state: state({ symbol: 'SR', fetchedAt: ago(5), at: ago(5) }), dates: ['2026-10-22'] }),
        subject({ symbol: 'SQ', latest: latest({ symbol: 'SQ' }), state: state({ symbol: 'SQ', outcome: 'error', at: ago(2) }) }),
        subject({ symbol: 'SP', latest: latest({ symbol: 'SP' }) }),
        matched('SO', { state: state({ symbol: 'SO', fetchedAt: ago(30), at: ago(30) }) }),
        matched('SN', { state: state({ symbol: 'SN', fetchedAt: ago(1), at: ago(1) }) }),
        subject({ symbol: 'SB' }),
        subject({ symbol: 'SA' }),
      ],
      NOW,
    );
    expect(plan.calls.map((call) => call.symbol)).toEqual(['SP', 'SQ', 'SR', 'SA', 'SB', 'SO', 'SS']);
    expect(plan.unmapped).toEqual([]);
  });

  it('separates the listings without a US ticker: they need no call', () => {
    const plan = planEstimates([subject({ symbol: 'ASML.AS' }), subject({ symbol: 'FOO.DE' }), subject({ symbol: 'MSFT' })], NOW);
    expect(plan.calls).toEqual([
      { symbol: 'FOO.DE', ticker: 'CRM' },
      { symbol: 'MSFT', ticker: 'MSFT' },
    ]);
    expect(plan.unmapped).toEqual(['ASML.AS']);
  });
});

const consensusState = async (h: EarningsHarness, symbol: string) => (await h.repo.getConsensus(symbol)).state;

async function runJob(h: EarningsHarness, trigger: 'scheduled' | 'manual' = 'scheduled'): Promise<unknown> {
  const before = h.queue.results.length;
  await h.queue.enqueue({ job: 'earningsEstimates', payload: { trigger } });
  await h.queue.drain();
  return h.queue.results.slice(before).at(-1)?.result;
}

describe('the earningsEstimates job', () => {
  it('does nothing without an Alpha Vantage key', async () => {
    const h = earningsHarness({ holdings: symbols(2) });
    expect(await runJob(h)).toEqual({ fetched: 0, stored: 0, skipped: 'no-key' });
  });

  it('stores the quarters and the state of a symbol, one call per step, and records every outcome', async () => {
    const fake = new FakeEstimates({ SA: SAMPLE_ESTIMATES, SB: { status: 'no-coverage' }, SC: { status: 'error', reason: 'the provider answered 503' } });
    const h = earningsHarness({ holdings: symbols(3), consensus: fake });
    expect(await runJob(h)).toEqual({ fetched: 3, stored: 1 });
    expect(fake.calls).toEqual(['SA', 'SB', 'SC']);
    const stored = await h.repo.getConsensus('SA');
    expect(stored.quarters.map((entry) => entry.quarterEnd)).toEqual(['2026-12-31', '2026-09-30']);
    expect(stored.quarters[1]).toMatchObject({ symbol: 'SA', ticker: 'SA', eps: { average: 2.1, analysts: 12 }, revenue: { average: 5_100_000_000 }, fetchedAt: NOW.toISOString() });
    expect(stored.state).toMatchObject({ outcome: 'ok', quarters: 2, fetchedAt: NOW.toISOString(), at: NOW.toISOString() });
    expect(await consensusState(h, 'SB')).toMatchObject({ outcome: 'no-coverage' });
    expect(await consensusState(h, 'SC')).toMatchObject({ outcome: 'error', detail: 'the provider answered 503' });
  });

  it('makes at most three calls in a run and eight in a day, and none when fewer than five of the 25 are left', async () => {
    const fake = new FakeEstimates({}, SAMPLE_ESTIMATES);
    const h = earningsHarness({ holdings: symbols(12), consensus: fake });
    expect(ESTIMATES_CALLS_PER_RUN).toBe(3);
    expect(await runJob(h)).toEqual({ fetched: 3, stored: 3 });
    expect(await runJob(h)).toEqual({ fetched: 3, stored: 3 });
    expect(await runJob(h)).toEqual({ fetched: 2, stored: 2, skipped: 'budget' });
    expect(await runJob(h)).toEqual({ fetched: 0, stored: 0, skipped: 'budget' });
    expect(fake.calls).toHaveLength(8);
    h.clock.advance(DAY);
    expect(await runJob(h)).toEqual({ fetched: 3, stored: 3 });
    expect(fake.calls).toHaveLength(11);
  });

  it('stops for the day when the shared allowance is nearly used (other jobs spent it)', async () => {
    const fake = new FakeEstimates({}, SAMPLE_ESTIMATES);
    const h = earningsHarness({ holdings: symbols(3), consensus: fake });
    await h.store.put({ PK: 'USAGE', SK: 'alphavantage', entityType: 'PROVIDER_USAGE', day: '2026-10-21', used: 21 });
    expect(await runJob(h)).toEqual({ fetched: 0, stored: 0, skipped: 'budget' });
    expect(fake.calls).toEqual([]);
    await h.store.put({ PK: 'USAGE', SK: 'alphavantage', entityType: 'PROVIDER_USAGE', day: '2026-10-21', used: 20 });
    expect(await runJob(h)).toMatchObject({ fetched: 1 });
  });

  it('records a premium notice, stops the run and does not ask again for a week', async () => {
    const fake = new FakeEstimates({ SA: { status: 'premium' } }, SAMPLE_ESTIMATES);
    const h = earningsHarness({ holdings: symbols(4), consensus: fake });
    expect(await runJob(h)).toEqual({ fetched: 1, stored: 0, stoppedBy: 'premium' });
    expect(fake.calls).toEqual(['SA']);
    expect(await consensusState(h, 'SA')).toMatchObject({ outcome: 'premium' });
    expect(await h.repo.getConsensusBlock()).toMatchObject({ reason: 'premium', until: '2026-10-28T19:30:00.000Z' });
    expect(await runJob(h)).toEqual({ fetched: 0, stored: 0, skipped: 'blocked' });
    h.clock.advance(6 * DAY);
    expect(await runJob(h)).toEqual({ fetched: 0, stored: 0, skipped: 'blocked' });
    h.clock.advance(2 * DAY);
    const result = await runJob(h);
    expect(result).toMatchObject({ fetched: 3 });
    expect(fake.calls.slice(1)).toEqual(['SB', 'SC', 'SD']);
  });

  it('records a rate limit, stops the run and tries again after the next UTC midnight', async () => {
    const fake = new FakeEstimates({ SA: SAMPLE_ESTIMATES, SB: { status: 'rate-limited' } }, SAMPLE_ESTIMATES);
    const h = earningsHarness({ holdings: symbols(4), consensus: fake });
    expect(await runJob(h)).toEqual({ fetched: 2, stored: 1, stoppedBy: 'rate-limited' });
    expect(await consensusState(h, 'SB')).toMatchObject({ outcome: 'rate-limited' });
    expect(await h.repo.getConsensusBlock()).toMatchObject({ reason: 'rate-limited', until: '2026-10-22T00:05:00.000Z' });
    expect(await runJob(h)).toMatchObject({ skipped: 'blocked' });
    h.clock.advance(5 * 3_600_000);
    expect(await runJob(h)).toEqual({ fetched: 2, stored: 2 });
    expect(fake.calls).toEqual(['SA', 'SB', 'SC', 'SD']);
  });

  it('keeps the figures of an earlier fetch when a later attempt fails', async () => {
    const answers: EstimatesAnswer[] = [SAMPLE_ESTIMATES, { status: 'error', reason: 'the request failed' }];
    const fake = new FakeEstimates({ SA: () => answers.shift()! });
    const h = earningsHarness({ holdings: symbols(1), consensus: fake });
    await runJob(h);
    h.clock.advance(15 * DAY);
    await runJob(h);
    const stored = await h.repo.getConsensus('SA');
    expect(stored.quarters).toHaveLength(2);
    expect(stored.state).toMatchObject({ outcome: 'error', detail: 'the request failed', fetchedAt: NOW.toISOString(), quarters: 2 });
  });

  it('records the listings without a US ticker as "no coverage" without a call, and asks the aliased ones under their US ticker', async () => {
    const fake = new FakeEstimates({ CRM: SAMPLE_ESTIMATES });
    const h = earningsHarness({
      holdings: [
        { symbol: 'ASML.AS', name: 'ASML Holding', template: 'generic' },
        { symbol: 'FOO.DE', name: 'Salesforce', template: 'generic' },
      ],
      consensus: fake,
    });
    expect(await runJob(h)).toEqual({ fetched: 1, stored: 1 });
    expect(fake.calls).toEqual(['CRM']);
    expect(await consensusState(h, 'ASML.AS')).toMatchObject({ outcome: 'no-coverage', detail: 'no US ticker is known for this listing' });
    expect((await h.repo.getConsensus('FOO.DE')).state).toMatchObject({ outcome: 'ok', ticker: 'CRM' });
    expect((await h.repo.getConsensus('FOO.DE')).quarters[0]).toMatchObject({ symbol: 'FOO.DE', ticker: 'CRM' });
    h.clock.advance(DAY);
    expect(await runJob(h)).toEqual({ fetched: 0, stored: 0, skipped: 'nothing-to-do' });
  });

  it('does nothing when every company was fetched recently', async () => {
    const fake = new FakeEstimates({}, SAMPLE_ESTIMATES);
    const h = earningsHarness({ holdings: symbols(2), consensus: fake });
    await runJob(h);
    h.clock.advance(DAY);
    expect(await runJob(h)).toEqual({ fetched: 0, stored: 0, skipped: 'nothing-to-do' });
    expect(fake.calls).toHaveLength(2);
  });

  it('refreshes a company that reports within three days, and asks first for the ones that reported with no estimates stored', async () => {
    const fake = new FakeEstimates({}, SAMPLE_ESTIMATES);
    const h = earningsHarness({ holdings: symbols(3), consensus: fake, calendar: { SB: ['2026-10-26'] } });
    await Promise.all(['SA', 'SB', 'SC'].map((symbol) => h.repo.putSummary(sampleSummary({ symbol, reportDate: '2026-10-14', generatedAt: '2026-10-14T20:00:00.000Z', origin: 'backfill' }))));
    await runJob(h);
    expect(fake.calls).toEqual(['SA', 'SB', 'SC']);
    h.clock.advance(4 * DAY);
    expect(await runJob(h)).toEqual({ fetched: 1, stored: 1 });
    expect(fake.calls.slice(3)).toEqual(['SB']);
  });

  it('defers the step on the host subrequest limit, and records an unexpected failure as the error of that symbol', async () => {
    const limit = Object.assign(new Error('Too many subrequests'), { name: 'SubrequestLimitError' });
    const fake = new FakeEstimates({ SA: limit }, SAMPLE_ESTIMATES);
    const h = earningsHarness({ holdings: symbols(1), consensus: fake });
    const handler = h.registry.earningsEstimates!;
    const step = await handler({ payload: { trigger: 'scheduled' } });
    expect(step).toMatchObject({ done: false, delayMs: 1000 });
    const cursor = (step as { next: string }).next;
    const again = await handler({ payload: { trigger: 'scheduled' }, cursor });
    expect(again).toMatchObject({ done: false });
    h.estimatesDeps.client = new FakeEstimates({ SA: new Error('boom') });
    expect(await handler({ payload: { trigger: 'scheduled' }, cursor })).toEqual({ done: true, result: { fetched: 1, stored: 0 } });
    expect(await consensusState(h, 'SA')).toMatchObject({ outcome: 'error', detail: 'the request failed' });
  });

  it('lets a failure of the store through: the step fails and is retried by the queue, nothing is recorded as an answer', async () => {
    const h = earningsHarness({ holdings: symbols(1), consensus: new FakeEstimates({}, SAMPLE_ESTIMATES) });
    h.repo.putConsensus = () => Promise.reject(new Error('store down'));
    await expect(h.registry.earningsEstimates!({ payload: { trigger: 'manual' } })).rejects.toThrow('store down');
  });
});
