import { describe, expect, it } from 'vitest';
import { sampleSummary } from './earnings-sample.js';
import {
  QUARTER_MATCH_DAYS,
  attachConsensus,
  classifyBeat,
  consensusKeys,
  matchQuarter,
  periodEndOf,
  readConsensusItems,
  surpriseOf,
  type ConsensusQuarter,
  type ConsensusState,
} from './earnings-consensus.js';

const quarter = (quarterEnd: string, extra: Partial<ConsensusQuarter> = {}): ConsensusQuarter => ({ symbol: 'NWND', quarterEnd, ticker: 'NWND', fetchedAt: '2026-10-12T06:20:00.000Z', ...extra });
const EPS = { average: 6.45, high: 6.6, low: 6.3, analysts: 12 };
const REVENUE = { average: 20_000_000_000, high: 20_500_000_000, low: 19_600_000_000, analysts: 10 };
const state = (extra: Partial<ConsensusState> = {}): ConsensusState => ({ symbol: 'NWND', outcome: 'ok', at: '2026-10-12T06:20:00.000Z', updatedAt: '2026-10-12T06:20:00.000Z', ...extra });

describe('classifyBeat', () => {
  it('is a beat, a miss or in line within half a percent of the estimate', () => {
    expect(classifyBeat(6.92, 6.45)).toEqual({ verdict: 'beat', surprisePct: 7.3 });
    expect(classifyBeat(1, 1.2)).toEqual({ verdict: 'miss', surprisePct: -16.7 });
    expect(classifyBeat(4.88, 4.9)).toEqual({ verdict: 'inline', surprisePct: -0.4 });
    expect(classifyBeat(1.005, 1)).toEqual({ verdict: 'beat', surprisePct: 0.5 });
  });

  it('measures a loss against the size of the estimate: a smaller loss is a beat', () => {
    expect(classifyBeat(-0.3, -0.5)).toEqual({ verdict: 'beat', surprisePct: 40 });
    expect(classifyBeat(-0.7, -0.5)).toEqual({ verdict: 'miss', surprisePct: -40 });
    expect(classifyBeat(0.2, -0.5)).toEqual({ verdict: 'beat', surprisePct: 140 });
  });

  it('has no percentage for a zero estimate, only the direction', () => {
    expect(classifyBeat(0.1, 0)).toEqual({ verdict: 'beat' });
    expect(classifyBeat(-0.1, 0)).toEqual({ verdict: 'miss' });
    expect(classifyBeat(0, 0)).toEqual({ verdict: 'inline' });
  });
});

describe('surpriseOf', () => {
  it('is the actual minus the estimate, in percent of the estimate', () => {
    expect(surpriseOf(21_000_000_000, 20_000_000_000)).toEqual({ amount: 1_000_000_000, pct: 5, verdict: 'beat' });
    expect(surpriseOf(undefined, 1)).toBeUndefined();
    expect(surpriseOf(0.1, 0)).toEqual({ amount: 0.1, verdict: 'beat' });
  });
});

describe('periodEndOf', () => {
  it('reads the date a release names its period with', () => {
    expect(periodEndOf('quarter ended June 30, 2026')).toBe('2026-06-30');
    expect(periodEndOf('three months ended Sept. 3, 2026')).toBe('2026-09-03');
    expect(periodEndOf('period ending 2026-03-31')).toBe('2026-03-31');
    expect(periodEndOf('Q3 2026')).toBeUndefined();
    expect(periodEndOf('Foo 12, 2026')).toBeUndefined();
  });
});

describe('matchQuarter', () => {
  const quarters = [quarter('2026-03-31'), quarter('2026-06-30'), quarter('2026-09-30'), quarter('2026-12-31')];

  it('takes the latest quarter that ended before the release when no period end is known', () => {
    expect(matchQuarter(sampleSummary({ reportDate: '2026-10-21' }), quarters)?.quarterEnd).toBe('2026-09-30');
    expect(matchQuarter(sampleSummary({ reportDate: '2026-07-22' }), quarters)?.quarterEnd).toBe('2026-06-30');
    expect(matchQuarter(sampleSummary({ reportDate: '2026-09-30' }), quarters)?.quarterEnd).toBe('2026-06-30');
  });

  it('takes no quarter that ended more than 120 days before, or after, the release', () => {
    expect(matchQuarter(sampleSummary({ reportDate: '2027-03-01' }), [quarter('2026-09-30')])).toBeUndefined();
    expect(matchQuarter(sampleSummary({ reportDate: '2026-01-01' }), [quarter('2026-03-31')])).toBeUndefined();
  });

  it('prefers the fiscal period end the release names, with a tolerance for 52-week years', () => {
    const named = sampleSummary({ reportDate: '2026-10-21', period: 'quarter ended September 26, 2026' });
    expect(matchQuarter(named, quarters)?.quarterEnd).toBe('2026-09-30');
    const far = sampleSummary({ reportDate: '2026-10-21', period: `quarter ended June 30, 2026` });
    expect(matchQuarter(far, quarters)?.quarterEnd).toBe('2026-06-30');
    expect(QUARTER_MATCH_DAYS).toBe(20);
  });

  it('falls back to the report date when the named period end is nowhere near a stored quarter', () => {
    const odd = sampleSummary({ reportDate: '2026-10-21', period: 'quarter ended January 5, 2020' });
    expect(matchQuarter(odd, quarters)?.quarterEnd).toBe('2026-09-30');
  });

  it('uses the hint of the calendar before anything else and picks the earlier quarter on a tie', () => {
    const summary = sampleSummary({ reportDate: '2026-10-21' });
    expect(matchQuarter(summary, quarters, '2026-06-28')?.quarterEnd).toBe('2026-06-30');
    expect(matchQuarter(summary, [quarter('2026-09-20'), quarter('2026-10-10')], '2026-09-30')?.quarterEnd).toBe('2026-09-20');
  });
});

describe('attachConsensus', () => {
  const summary = sampleSummary();

  it('joins EPS and revenue with the surprise of each against the actual', () => {
    const joined = attachConsensus(summary, { quarters: [quarter('2026-09-30', { eps: EPS, revenue: REVENUE })], state: state() });
    expect(joined.consensus).toEqual({
      provider: 'Alpha Vantage',
      quarterEnd: '2026-09-30',
      asOf: '2026-10-12T06:20:00.000Z',
      eps: { ...EPS, source: 'consensus', surprise: { amount: 0.47, pct: 7.3, verdict: 'beat' } },
      revenue: { ...REVENUE, source: 'consensus', surprise: { amount: 710_000_000, pct: 3.6, verdict: 'beat' } },
    });
    expect(summary.consensus).toBeUndefined();
  });

  it('has no surprise when the summary has no actual for the figure', () => {
    const noActual = sampleSummary({ headline: {} });
    const joined = attachConsensus(noActual, { quarters: [quarter('2026-09-30', { eps: EPS })] });
    expect(joined.consensus?.eps).toEqual({ ...EPS, source: 'consensus' });
    expect(joined.consensus?.reason).toBe('no-figure');
  });

  it('falls back to the estimate the release was stored with, then to the calendar', () => {
    const release = attachConsensus(summary, { quarters: [] });
    expect(release.consensus?.eps).toEqual({ average: 6.45, source: 'release', surprise: { amount: 0.47, pct: 7.3, verdict: 'beat' } });
    const plain = sampleSummary({ headline: { eps: { value: 6.92, unit: 'perShare' } } });
    const calendar = attachConsensus(plain, { quarters: [], calendar: [{ date: '2026-10-22', epsEstimate: 6.5, currency: 'USD' }, { date: '2026-04-20', epsEstimate: 1 }] });
    expect(calendar.consensus?.eps).toEqual({ average: 6.5, source: 'calendar', surprise: { amount: 0.42, pct: 6.5, verdict: 'beat' } });
    expect(attachConsensus(plain, { quarters: [], calendar: [{ date: '2026-10-22', epsEstimate: 6.5, currency: 'EUR' }] }).consensus?.eps).toBeUndefined();
    expect(attachConsensus(plain, { quarters: [], calendar: [{ date: '2026-12-22', epsEstimate: 6.5 }] }).consensus?.eps).toBeUndefined();
    expect(attachConsensus(plain, { quarters: [], calendar: [{ date: '2026-10-22' }] }).consensus?.eps).toBeUndefined();
  });

  it('uses the fiscal period end of the calendar to find the quarter', () => {
    const joined = attachConsensus(summary, {
      quarters: [quarter('2026-06-30', { eps: { average: 1 } }), quarter('2026-09-30', { eps: EPS })],
      calendar: [{ date: '2026-10-21', fiscalPeriodEnd: '2026-06-30' }],
    });
    expect(joined.consensus?.quarterEnd).toBe('2026-06-30');
  });

  it('drops a consensus whose revenue is far from the reported revenue (another currency or company)', () => {
    const wrong = attachConsensus(summary, { quarters: [quarter('2026-09-30', { eps: EPS, revenue: { average: 3_000_000_000 } })], state: state() });
    expect(wrong.consensus).toMatchObject({ provider: 'Alpha Vantage', reason: 'mismatch' });
    expect(wrong.consensus?.revenue).toBeUndefined();
    expect(wrong.consensus?.quarterEnd).toBeUndefined();
    const small = attachConsensus(summary, { quarters: [quarter('2026-09-30', { revenue: { average: 1_000_000_000_000 } })] });
    expect(small.consensus?.reason).toBe('mismatch');
  });

  it('does not judge the size when the estimate or the actual revenue is zero, negative or missing', () => {
    expect(attachConsensus(summary, { quarters: [quarter('2026-09-30', { revenue: { average: 0 } })] }).consensus?.revenue?.surprise?.verdict).toBe('beat');
    expect(attachConsensus(sampleSummary({ headline: {} }), { quarters: [quarter('2026-09-30', { revenue: { average: 5 } })] }).consensus?.revenue).toBeDefined();
  });

  it('says why there is no estimate, from the job record', () => {
    const reasonFor = (current: ConsensusState | null | undefined, quarters: ConsensusQuarter[] = []) => attachConsensus(sampleSummary({ headline: { revenue: { value: 1, unit: 'money' } } }), { quarters, state: current }).consensus;
    expect(reasonFor(undefined)?.reason).toBe('pending');
    const keyless = attachConsensus(sampleSummary({ headline: { revenue: { value: 1, unit: 'money' } } }), { quarters: [], keyed: false }).consensus;
    expect(keyless?.reason).toBe('no-key');
    expect(attachConsensus(sampleSummary({ headline: { revenue: { value: 1, unit: 'money' } } }), { quarters: [], state: state({ outcome: 'premium' }), keyed: false }).consensus?.reason).toBe('premium');
    expect(reasonFor(null)?.reason).toBe('pending');
    expect(reasonFor(state({ outcome: 'no-coverage' }))?.reason).toBe('no-coverage');
    expect(reasonFor(state({ outcome: 'premium' }))?.reason).toBe('premium');
    expect(reasonFor(state({ outcome: 'rate-limited' }))?.reason).toBe('rate-limited');
    expect(reasonFor(state({ outcome: 'error', detail: 'the request failed' }))).toMatchObject({ reason: 'error', detail: 'the request failed' });
    expect(reasonFor(state({ outcome: 'error' }))?.detail).toBeUndefined();
    expect(reasonFor(state({ outcome: 'rate-limited', detail: 'higher API call volume', retryAt: '2026-10-22T00:01:00.000Z' }))).toMatchObject({ reason: 'rate-limited', detail: 'higher API call volume', retryAt: '2026-10-22T00:01:00.000Z' });
    expect(reasonFor(state({ outcome: 'rate-limited' }))?.retryAt).toBeUndefined();
    expect(reasonFor(state())?.reason).toBe('no-quarter');
    expect(reasonFor(state({ outcome: 'error' }), [quarter('2026-09-30', { eps: EPS })])?.reason).toBe('no-figure');
  });

  it('has no reason when both figures have an estimate', () => {
    const joined = attachConsensus(summary, { quarters: [quarter('2026-09-30', { eps: EPS, revenue: REVENUE })] });
    expect(joined.consensus?.reason).toBeUndefined();
  });
});

describe('storage', () => {
  it('keeps its keys apart from the calendar and the summaries', () => {
    expect(consensusKeys.quarter('NWND', '2026-09-30')).toEqual({ PK: 'TICKER#NWND', SK: 'EARNEST#2026-09-30' });
    expect(consensusKeys.state('NWND')).toEqual({ PK: 'TICKER#NWND', SK: 'EARNEST#STATE' });
    expect(consensusKeys.state('NWND').SK.startsWith('EARN#')).toBe(false);
    expect(consensusKeys.state('NWND').SK.startsWith('EARNSUM#')).toBe(false);
  });

  it('reads the rows of a symbol into its quarters and its state', () => {
    const rows = [
      { ...consensusKeys.state('NWND'), entityType: 'EARNINGS_CONSENSUS_STATE', ...state() },
      { ...consensusKeys.quarter('NWND', '2026-09-30'), entityType: 'EARNINGS_CONSENSUS', ...quarter('2026-09-30', { eps: EPS }) },
      { PK: 'TICKER#NWND', SK: 'EARNEST#other', entityType: 'SOMETHING_ELSE' },
    ];
    expect(readConsensusItems(rows)).toEqual({ state: state(), quarters: [quarter('2026-09-30', { eps: EPS })] });
    expect(readConsensusItems([])).toEqual({ state: null, quarters: [] });
  });
});
