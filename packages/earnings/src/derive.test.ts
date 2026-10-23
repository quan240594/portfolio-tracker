import { describe, expect, it } from 'vitest';
import { sampleSummary, type EarningsSummary } from '@portfolio/shared';
import { classifyBeat, changePct, deriveSummary, type DeriveInput } from './derive.js';
import type { Verified, VerifiedPair, VerifiedValue } from './verify.js';

const value = (amount: number, raw = String(amount), kind: VerifiedValue['kind'] = 'money', scale?: number): VerifiedValue => ({ value: amount, raw, kind, ...(scale === undefined ? {} : { scale }) });
const pair = (amount: number, yearAgo?: number, kind: VerifiedValue['kind'] = 'money'): VerifiedPair => ({ value: value(amount, `raw${amount}`, kind), ...(yearAgo === undefined ? {} : { yearAgo: value(yearAgo, `raw${yearAgo}`, kind) }) });

const empty = (): Verified => ({ kpis: {}, guidance: [], segments: [], keyUpdates: [] });
const base = (verified: Verified, extra: Partial<DeriveInput> = {}): DeriveInput => ({
  verified,
  dropped: [],
  symbol: 'TEST',
  name: 'Test Co',
  template: 'generic',
  filing: { url: 'https://www.sec.gov/x', accession: '0001-26-000001', form: '8-K', reportDate: '2026-10-21' },
  origin: 'live',
  model: 'm',
  neurons: 10,
  calls: 1,
  now: new Date('2026-10-22T00:00:00.000Z'),
  ...extra,
});

describe('classifyBeat', () => {
  it.each([
    [1.01, 1, 'beat', 1],
    [1.005, 1, 'beat', 0.5],
    [1.0049, 1, 'inline', 0.5],
    [1, 1, 'inline', 0],
    [0.995, 1, 'miss', -0.5],
    [0.9951, 1, 'inline', -0.5],
    [0.9, 1, 'miss', -10],
    [-0.9, -1, 'beat', 10],
    [-1.1, -1, 'miss', -10],
  ])('actual %s vs estimate %s is %s', (actual, estimate, verdict, pct) => {
    const result = classifyBeat(actual, estimate);
    expect(result.verdict).toBe(verdict);
    expect(Math.abs(result.surprisePct! - pct)).toBeLessThan(0.51);
  });

  it('against an estimate of zero there is no percentage', () => {
    expect(classifyBeat(0.1, 0)).toEqual({ verdict: 'beat' });
    expect(classifyBeat(-0.1, 0)).toEqual({ verdict: 'miss' });
    expect(classifyBeat(0, 0)).toEqual({ verdict: 'inline' });
  });

  it('exactly +0.5 % is a beat and exactly -0.5 % a miss', () => {
    expect(classifyBeat(201, 200).verdict).toBe('beat');
    expect(classifyBeat(199, 200).verdict).toBe('miss');
    expect(classifyBeat(200.99, 200).verdict).toBe('inline');
  });
});

describe('changePct', () => {
  it('is absent against zero, a loss or nothing', () => {
    expect(changePct(5, 0)).toBeUndefined();
    expect(changePct(5, Number.NaN)).toBeUndefined();
    expect(changePct(5, -2)).toBeUndefined();
    expect(changePct(5, undefined)).toBeUndefined();
    expect(changePct(110, 100)).toBe(10);
    expect(changePct(-10, 100)).toBe(-110);
  });
});

describe('deriveSummary', () => {
  it('reported free cash flow wins over calculated, and shares divide it', () => {
    const verified = { ...empty(), revenue: pair(100, 80), freeCashFlow: pair(30, 20), operatingCashFlow: pair(50, 40), capex: pair(-10, 5), dilutedShares: pair(10, 10, 'plain') };
    const { headline } = deriveSummary(base(verified));
    expect(headline.fcf).toMatchObject({ value: 30, basis: 'reported', yoyPct: 50 });
    expect(headline.fcfPerShare).toMatchObject({ value: 3, basis: 'calculated', yearAgo: 2, yoyPct: 50 });
  });

  it('calculated free cash flow is operating cash flow minus the absolute capex, with its year-ago', () => {
    const { headline } = deriveSummary(base({ ...empty(), operatingCashFlow: pair(50, 40), capex: pair(-10, 5) }));
    expect(headline.fcf).toMatchObject({ value: 40, basis: 'calculated', yearAgo: 35, yoyPct: 14.3 });
    expect(headline.fcfPerShare).toBeUndefined();
    const without = deriveSummary(base({ ...empty(), operatingCashFlow: pair(50), capex: pair(10) })).headline.fcf!;
    expect(without.yearAgo).toBeUndefined();
    expect(deriveSummary(base({ ...empty(), operatingCashFlow: pair(50) })).headline.fcf).toBeUndefined();
  });

  it('a non-positive share count gives no per-share figure', () => {
    expect(deriveSummary(base({ ...empty(), freeCashFlow: pair(30), dilutedShares: pair(0, undefined, 'plain') })).headline.fcfPerShare).toBeUndefined();
  });

  it('banks and REITs have no free cash flow even when the numbers exist', () => {
    const verified = { ...empty(), freeCashFlow: pair(30), operatingCashFlow: pair(50), capex: pair(10), revenue: pair(100) };
    expect(deriveSummary(base(verified, { template: 'bank' })).headline.fcf).toBeUndefined();
    expect(deriveSummary(base(verified, { template: 'reit' })).headline.operatingCashFlow).toBeUndefined();
  });

  it('the operating margin is printed when printed and calculated otherwise', () => {
    const printed = deriveSummary(base({ ...empty(), operatingMargin: pair(20, 18, 'percent'), operatingIncome: pair(10), revenue: pair(100) })).headline.operatingMargin!;
    expect(printed).toMatchObject({ value: 20, yoyPoints: 2 });
    expect(printed.basis).toBeUndefined();
    const calculated = deriveSummary(base({ ...empty(), operatingIncome: pair(25, 20), revenue: pair(100, 100) })).headline.operatingMargin!;
    expect(calculated).toMatchObject({ value: 25, basis: 'calculated', yearAgo: 20, yoyPoints: 5 });
    expect(deriveSummary(base({ ...empty(), operatingIncome: pair(25), revenue: pair(0) })).headline.operatingMargin).toBeUndefined();
    expect(deriveSummary(base({ ...empty(), operatingIncome: pair(25) })).headline.operatingMargin).toBeUndefined();
  });

  it('EPS takes the basis the consensus source reports, and drops an estimate that matches neither', () => {
    const verified = { ...empty(), epsAdjusted: pair(2, 1.5), epsGaap: pair(1.2, 1) };
    expect(deriveSummary(base(verified)).headline.eps).toMatchObject({ value: 2, basis: 'adjusted' });
    expect(deriveSummary(base(verified, { estimate: { estimate: 1.1, reportedEps: 1.2 } })).headline.eps).toMatchObject({ value: 1.2, basis: 'GAAP', estimate: 1.1, verdict: 'beat' });
    expect(deriveSummary(base(verified, { estimate: { estimate: 1.9, reportedEps: 2.001 } })).headline.eps).toMatchObject({ value: 2, basis: 'adjusted', estimate: 1.9, verdict: 'beat', surprisePct: 5.3 });
    const mismatch = deriveSummary(base(verified, { estimate: { estimate: 1.9, reportedEps: 7 } })).headline.eps!;
    expect(mismatch.estimate).toBeUndefined();
    expect(mismatch.verdict).toBeUndefined();
    expect(deriveSummary(base(verified, { estimate: { estimate: 2.4 } })).headline.eps).toMatchObject({ estimate: 2.4, verdict: 'miss' });
    expect(deriveSummary(base({ ...empty(), epsGaap: pair(1.2) })).headline.eps).toMatchObject({ basis: 'GAAP' });
    expect(deriveSummary(base(empty())).headline.eps).toBeUndefined();
  });

  it('currency comes from the release, then the profile, then USD', () => {
    expect(deriveSummary(base({ ...empty(), currency: 'EUR' }, { fallbackCurrency: 'GBP' })).reportingCurrency).toBe('EUR');
    expect(deriveSummary(base(empty(), { fallbackCurrency: 'GBP' })).reportingCurrency).toBe('GBP');
    expect(deriveSummary(base(empty())).reportingCurrency).toBe('USD');
    expect(deriveSummary(base(empty())).period).toBe('Latest quarter');
  });

  it('is stored without undefined values and caps the dropped list', () => {
    const summary = deriveSummary(base(empty(), { dropped: Array.from({ length: 30 }, () => 'quote') }));
    expect(summary.verification).toMatchObject({ dropped: 30, model: 'm', neuronsEstimate: 10, calls: 1 });
    expect(summary.verification.droppedFields).toHaveLength(20);
    expect(summary.quote).toBeUndefined();
    expect(summary.previousReportDate).toBeUndefined();
  });
});

describe('quarter over quarter', () => {
  const previous = (): EarningsSummary =>
    sampleSummary({
      reportingCurrency: 'USD',
      reportDate: '2026-07-22',
      headline: {
        eps: { value: 1.5, unit: 'perShare', basis: 'adjusted' },
        revenue: { value: 80, unit: 'money' },
        operatingMargin: { value: 18, unit: 'percent' },
        fcf: { value: 20, unit: 'money', basis: 'reported' },
      },
      kpis: [{ key: 'affoPerShare', label: 'AFFO per share', unit: 'perShare', metric: { value: 1, unit: 'perShare' } }],
      guidance: [{ label: 'Net sales', period: 'full year 2026', unit: 'money', low: 100, high: 110, raw: 'x' }, { label: 'Only before', unit: 'money', point: 5, raw: 'x' }],
    });
  const verified = (): Verified => ({
    ...empty(),
    epsAdjusted: pair(2),
    revenue: pair(100),
    operatingMargin: pair(20, undefined, 'percent'),
    freeCashFlow: pair(30),
    kpis: { affoPerShare: pair(1.1) },
    guidance: [
      { label: 'Net sales', period: 'full year 2026', low: value(105), high: value(115) },
      { label: 'Net sales', period: 'full year 2026', point: value(105) },
      { label: 'Net sales', period: 'full year 2026', point: value(95) },
      { label: 'Net sales', period: 'full year 2026', low: value(100), high: value(110) },
      { label: 'Brand new', point: value(10, '10', 'money', 1e6) },
      { label: 'Pct', point: value(10, '10%', 'percent') },
      { label: 'Count', point: value(10, '10', 'plain') },
      { label: 'Per share', low: value(2, '$2') },
    ],
  });

  it('compares with the previous stored summary when the basis and currency match', () => {
    const summary = deriveSummary(base(verified(), { previous: previous() }));
    expect(summary.previousReportDate).toBe('2026-07-22');
    expect(summary.headline.eps).toMatchObject({ qoqPct: 33.3 });
    expect(summary.headline.revenue).toMatchObject({ qoqPct: 25 });
    expect(summary.headline.operatingMargin).toMatchObject({ qoqPoints: 2 });
    expect(summary.headline.fcf?.qoqPct).toBe(50);
    const reit = deriveSummary(base(verified(), { previous: previous(), template: 'reit' }));
    expect(reit.kpis.find((kpi) => kpi.key === 'affoPerShare')?.metric?.qoqPct).toBe(10);
  });

  it('computes the guidance direction against the previous one', () => {
    const summary = deriveSummary(base(verified(), { previous: previous() }));
    expect(summary.guidance.map((entry) => entry.direction)).toEqual(['raised', 'maintained', 'lowered', 'maintained', 'new', 'new', 'new', 'new']);
    expect(summary.guidance.map((entry) => entry.unit)).toEqual(['perShare', 'perShare', 'perShare', 'perShare', 'money', 'percent', 'count', 'perShare']);
    expect(summary.guidance[0]!.raw).toBe('105 to 115');
    expect(summary.guidance[4]!.raw).toBe('10');
  });

  it('gives no direction for the first stored summary', () => {
    expect(deriveSummary(base(verified())).guidance.every((entry) => entry.direction === undefined)).toBe(true);
    expect(deriveSummary(base(verified())).previousReportDate).toBeUndefined();
  });

  it('does not compare a different basis, a different currency, or a unit that changed', () => {
    const gaap = deriveSummary(base({ ...verified(), epsAdjusted: undefined, epsGaap: pair(2) }, { previous: previous() }));
    expect(gaap.headline.eps?.qoqPct).toBeUndefined();
    const euro = deriveSummary(base({ ...verified(), currency: 'EUR' }, { previous: previous() }));
    expect(euro.headline.revenue?.qoqPct).toBeUndefined();
    expect(euro.previousReportDate).toBeUndefined();
    const calculated = deriveSummary(base({ ...verified(), freeCashFlow: undefined, operatingCashFlow: pair(50), capex: pair(10) }, { previous: previous() }));
    expect(calculated.headline.fcf?.qoqPct).toBeUndefined();
    const fromLoss = previous();
    fromLoss.headline.revenue = { value: -5, unit: 'money' };
    expect(deriveSummary(base(verified(), { previous: fromLoss })).headline.revenue?.qoqPct).toBeUndefined();
  });

  it('computes segment growth from the printed year-ago value', () => {
    const summary = deriveSummary(base({ ...empty(), segments: [{ name: 'A', value: value(110), yearAgo: value(100) }, { name: 'B', value: value(5) }] }));
    expect(summary.segments).toEqual([expect.objectContaining({ name: 'A', yearAgo: 100, yoyPct: 10 }), { name: 'B', value: 5, raw: '5' }]);
  });
});
