import { describe, expect, it } from 'vitest';
import type { EstimatesAnswer } from '@portfolio/prices';
import type { ConsensusQuarter, EarningsHolding } from '@portfolio/shared';
import { FakeEstimates, SAMPLE_EARNINGS, SAMPLE_ESTIMATES } from './testing/fake-estimates.js';
import { earningsHarness, NOW, type EarningsHarness } from './testing/harness.js';

const DAY = 86_400_000;
const symbols = (count: number): EarningsHolding[] => Array.from({ length: count }, (_, index) => ({ symbol: `S${String.fromCharCode(65 + index)}`, name: `Company ${index}`, template: 'generic' as const }));
const iso = (ms: number): string => new Date(ms).toISOString();
const GENERIC: EstimatesAnswer = { status: 'rate-limited', scope: 'other', detail: 'Thank you for using Alpha Vantage! Please contact premium@alphavantage.co if you are targeting a higher API call volume.' };

async function runJob(h: EarningsHarness): Promise<unknown> {
  const before = h.queue.results.length;
  await h.queue.enqueue({ job: 'earningsEstimates', payload: { trigger: 'scheduled' } });
  await h.queue.drain();
  return h.queue.results.slice(before).at(-1)?.result;
}

const stateOf = async (h: EarningsHarness, symbol: string) => (await h.repo.getConsensus(symbol)).state;

describe('the earningsEstimates job when the key cannot read EARNINGS_ESTIMATES', () => {
  it('tells it from a throttle by a control call: generic limit text while EARNINGS works notes the endpoint and stores EPS-only rows, without any back-off', async () => {
    const fake = new FakeEstimates({}, GENERIC, { fallback: SAMPLE_EARNINGS });
    const h = earningsHarness({ holdings: symbols(3), consensus: fake });
    expect(await runJob(h)).toEqual({ fetched: 3, stored: 2, endpoint: 'unavailable-on-key' });
    expect(fake.order).toEqual(['EARNINGS_ESTIMATES:SA', 'EARNINGS:SA', 'EARNINGS:SB']);
    expect(await h.repo.getConsensusEndpoint()).toEqual({ state: 'unavailable-on-key', at: NOW.toISOString(), retryAt: iso(NOW.getTime() + 7 * DAY), detail: expect.stringContaining('higher API call volume') });
    expect(await h.repo.getConsensusBlock()).toBeNull();
    const stored = await h.repo.getConsensus('SA');
    expect(stored.state).toMatchObject({ outcome: 'ok', source: 'eps-only', quarters: 2, ticker: 'SA', fetchedAt: NOW.toISOString() });
    expect(stored.state?.retryAt).toBeUndefined();
    expect(stored.quarters).toEqual([
      { symbol: 'SA', quarterEnd: '2026-09-30', eps: { average: 2.1 }, reportedEps: 2.18, providerSurprise: 0.08, ticker: 'SA', fetchedAt: NOW.toISOString(), source: 'eps-only' },
      { symbol: 'SA', quarterEnd: '2026-06-30', eps: { average: 1.95 }, reportedEps: 2, providerSurprise: 0.05, ticker: 'SA', fetchedAt: NOW.toISOString(), source: 'eps-only' },
    ]);
    expect(stored.quarters[0]).not.toHaveProperty('revenue');
    expect(await stateOf(h, 'SB')).toMatchObject({ outcome: 'ok', source: 'eps-only' });
  });

  it('treats both calls refused the same way as a real throttle: the existing back-off, no endpoint note', async () => {
    const fake = new FakeEstimates({}, GENERIC, { fallback: GENERIC });
    const h = earningsHarness({ holdings: symbols(3), consensus: fake });
    expect(await runJob(h)).toEqual({ fetched: 2, stored: 0, stoppedBy: 'rate-limited' });
    expect(fake.order).toEqual(['EARNINGS_ESTIMATES:SA', 'EARNINGS:SA']);
    expect(await h.repo.getConsensusEndpoint()).toBeNull();
    expect(await h.repo.getConsensusBlock()).toMatchObject({ reason: 'rate-limited', scope: 'other', until: iso(NOW.getTime() + 15 * 60_000) });
    expect(await stateOf(h, 'SA')).toMatchObject({ outcome: 'rate-limited' });
  });

  it('does not conclude anything from a control call that gave no figures (no coverage, an error): it stays a throttle', async () => {
    const fake = new FakeEstimates({}, GENERIC);
    const h = earningsHarness({ holdings: symbols(1), consensus: fake });
    expect(await runJob(h)).toEqual({ fetched: 2, stored: 0, stoppedBy: 'rate-limited' });
    expect(await h.repo.getConsensusEndpoint()).toBeNull();
  });

  it('makes no control call when the allowance is spent, and backs off as before', async () => {
    const fake = new FakeEstimates({}, GENERIC, { fallback: SAMPLE_EARNINGS });
    const h = earningsHarness({ holdings: symbols(2), consensus: fake });
    // 20 used: the first call leaves 4, under the reserve of 5 for the control call.
    await h.store.put({ PK: 'USAGE', SK: 'alphavantage', entityType: 'PROVIDER_USAGE', day: '2026-10-21', used: 20 });
    expect(await runJob(h)).toEqual({ fetched: 1, stored: 0, stoppedBy: 'rate-limited' });
    expect(fake.earningsCalls).toEqual([]);
    expect(await h.repo.getConsensusEndpoint()).toBeNull();
  });

  it('does not lose the answer when the host defers the control call', async () => {
    const limit = Object.assign(new Error('Too many subrequests'), { name: 'SubrequestLimitError' });
    const fake = new FakeEstimates({}, GENERIC, { fallback: limit });
    const h = earningsHarness({ holdings: symbols(1), consensus: fake });
    expect(await runJob(h)).toEqual({ fetched: 1, stored: 0, stoppedBy: 'rate-limited' });
    expect(await stateOf(h, 'SA')).toMatchObject({ outcome: 'rate-limited' });
  });

  it('uses EARNINGS only for a week: one call per step in the same order, within the same cap, and never EARNINGS_ESTIMATES', async () => {
    const fake = new FakeEstimates({}, GENERIC, { fallback: SAMPLE_EARNINGS });
    const h = earningsHarness({ holdings: symbols(12), consensus: fake });
    await runJob(h);
    h.clock.advance(DAY);
    const before = fake.order.length;
    expect(await runJob(h)).toEqual({ fetched: 3, stored: 3 });
    expect(fake.order.slice(before)).toEqual(['EARNINGS:SC', 'EARNINGS:SD', 'EARNINGS:SE']);
    h.clock.advance(DAY);
    await runJob(h);
    h.clock.advance(DAY);
    await runJob(h);
    expect(fake.calls).toEqual(['SA']);
    expect(fake.earningsCalls.length).toBeLessThanOrEqual(8 * 3);
  });

  it('keeps the daily cap of eight calls of its own', async () => {
    const fake = new FakeEstimates({}, GENERIC, { fallback: SAMPLE_EARNINGS });
    const h = earningsHarness({ holdings: symbols(12), consensus: fake });
    await runJob(h);
    await runJob(h);
    await runJob(h);
    await runJob(h);
    expect(fake.order).toHaveLength(8);
  });

  it('asks EARNINGS_ESTIMATES once more after seven days: still refused renews the note for a week, figures end it', async () => {
    const fake = new FakeEstimates({}, GENERIC, { fallback: SAMPLE_EARNINGS });
    const h = earningsHarness({ holdings: symbols(3), consensus: fake });
    await runJob(h);
    h.clock.advance(7 * DAY + 60_000);
    const before = fake.order.length;
    expect(await runJob(h)).toMatchObject({ endpoint: 'unavailable-on-key' });
    expect(fake.order[before]).toBe('EARNINGS_ESTIMATES:SC');
    expect(fake.order.slice(before).filter((call) => call.startsWith('EARNINGS_ESTIMATES'))).toHaveLength(1);
    expect((await h.repo.getConsensusEndpoint())?.retryAt).toBe(iso(h.clock.now().getTime() + 7 * DAY));

    h.clock.advance(7 * DAY + 60_000);
    h.estimatesDeps.client = new FakeEstimates({}, SAMPLE_ESTIMATES, { fallback: SAMPLE_EARNINGS });
    expect(await runJob(h)).toMatchObject({ fetched: 2, stored: 2 });
    expect(await h.repo.getConsensusEndpoint()).toBeNull();
    expect((await stateOf(h, 'SA'))?.source).toBeUndefined();
  });

  it('records a company the provider has no estimate for as "no coverage"', async () => {
    const none: EstimatesAnswer = { status: 'ok', quarters: [], available: 12 };
    const fake = new FakeEstimates({}, GENERIC, { replies: { SB: none, SC: { status: 'no-coverage' } }, fallback: SAMPLE_EARNINGS });
    const h = earningsHarness({ holdings: symbols(3), consensus: fake });
    await runJob(h);
    h.clock.advance(DAY);
    await runJob(h);
    expect(await stateOf(h, 'SB')).toMatchObject({ outcome: 'no-coverage' });
    expect(await stateOf(h, 'SC')).toMatchObject({ outcome: 'no-coverage' });
  });

  it('treats a refusal of EARNINGS itself as a real throttle', async () => {
    const fake = new FakeEstimates({}, GENERIC, { replies: { SB: GENERIC }, fallback: SAMPLE_EARNINGS });
    const h = earningsHarness({ holdings: symbols(3), consensus: fake });
    expect(await runJob(h)).toEqual({ fetched: 3, stored: 1, endpoint: 'unavailable-on-key', stoppedBy: 'rate-limited' });
    expect(await h.repo.getConsensusBlock()).toMatchObject({ reason: 'rate-limited', scope: 'other' });
  });

  it('leaves a quarter that has a full consensus row alone', async () => {
    const full: ConsensusQuarter = { symbol: 'SA', quarterEnd: '2026-09-30', ticker: 'SA', fetchedAt: '2026-09-01T00:00:00.000Z', eps: { average: 2.05, high: 2.2, low: 1.9, analysts: 12 }, revenue: { average: 5e9 } };
    const fake = new FakeEstimates({}, GENERIC, { fallback: SAMPLE_EARNINGS });
    const h = earningsHarness({ holdings: symbols(1), consensus: fake });
    await h.repo.putConsensus([full], { symbol: 'SA', outcome: 'error', at: '2026-09-01T00:00:00.000Z', fetchedAt: full.fetchedAt, ticker: 'SA', updatedAt: full.fetchedAt });
    await runJob(h);
    const stored = (await h.repo.getConsensus('SA')).quarters;
    expect(stored.find((quarter) => quarter.quarterEnd === '2026-09-30')).toEqual(full);
    expect(stored.find((quarter) => quarter.quarterEnd === '2026-06-30')).toMatchObject({ source: 'eps-only' });
  });

  it('is not misled by an explicit premium notice when the control call is refused too: the endpoint is still noted, no company is recorded', async () => {
    const fake = new FakeEstimates({ SA: { status: 'premium', detail: 'This is a premium endpoint.' } }, GENERIC, { fallback: GENERIC });
    const h = earningsHarness({ holdings: symbols(1), consensus: fake });
    const result = await runJob(h);
    expect(result).toMatchObject({ endpoint: 'unavailable-on-key', stored: 0 });
    expect(await stateOf(h, 'SA')).toBeNull();
  });

  it('clears the pause of an earlier throttle once EARNINGS gives figures', async () => {
    const fake = new FakeEstimates({}, GENERIC, { fallback: SAMPLE_EARNINGS });
    const h = earningsHarness({ holdings: symbols(2), consensus: fake });
    await h.repo.putConsensusBlock({ until: iso(NOW.getTime() - 1000), reason: 'rate-limited', at: iso(NOW.getTime() - 3_600_000), scope: 'other', strikes: 1 });
    await runJob(h);
    expect(await h.repo.getConsensusBlock()).toBeNull();
  });
});
