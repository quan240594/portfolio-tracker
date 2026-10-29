import { describe, expect, it } from 'vitest';
import { sampleDemoSummaries, sampleSummary } from '@portfolio/shared';
import { sp } from '../../test/utils';
import { FIRST_QUARTER_NOTE, NOT_AVAILABLE, NOT_DISCLOSED, NO_ESTIMATE, REASON_TEXT, beatText, changeParts, estimateOf, compactCount, formatGrowth, formatMetric, formatPoints, growthLines, guidanceText, hasQuarterComparison, labelOf, metricOf, reasonText, scorecardNote, scorecardRows } from './earningsModel';
import { CONSENSUS_REASONS, attachConsensus } from '@portfolio/shared';

const [bank, saas] = sampleDemoSummaries();
const NOW = new Date(2026, 9, 29, 9, 0);

describe('formats', () => {
  it('writes sums compactly in English and per-share amounts and percentages in the app locale', () => {
    expect(formatMetric(20_710_000_000, 'money', 'USD')).toBe('$20.71B');
    expect(formatMetric(850_000_000, 'money', 'EUR')).toBe('€850M');
    expect(sp(formatMetric(6.92, 'perShare', 'USD'))).toBe('US$ 6,92');
    expect(sp(formatMetric(64.5, 'perShare', 'EUR'))).toBe('€ 64,50');
    expect(formatMetric(17.2, 'percent', 'USD')).toBe('17,2%');
    expect(formatMetric(2.456, 'ratio', 'USD')).toBe('2.46x');
    expect(formatMetric(758_000_000, 'count', 'USD')).toBe('758M');
    expect(compactCount(-1_200_000_000)).toBe('-1.2B');
    expect(compactCount(950)).toBe('950');
  });

  it('signs growth and points', () => {
    expect(formatGrowth(11.04)).toBe('+11%');
    expect(formatGrowth(7.34)).toBe('+7,3%');
    expect(formatGrowth(-3.4)).toBe('−3,4%');
    expect(formatPoints(1.1)).toBe('+1,1 pt');
    expect(formatPoints(-0.5)).toBe('-0,5 pt');
  });
});

describe('scorecardRows', () => {
  it('shows expected, actual and the verdict, and says so when there is no estimate', () => {
    const rows = scorecardRows(sampleSummary());
    expect(rows.map((row) => [row.key, row.label, row.hasEstimate, row.verdict, row.surprise])).toEqual([
      ['eps', 'EPS', true, 'beat', '+7,3%'],
      ['revenue', 'Revenue', false, undefined, undefined],
    ]);
    expect(rows[0]).toMatchObject({ basis: 'adjusted', actual: expect.stringContaining('6,92') });
    expect(rows[1]).toMatchObject({ expected: NO_ESTIMATE, actual: '$20.71B', disclosed: true });
  });

  it('uses AFFO per share for a REIT and says not disclosed for a missing figure', () => {
    const reit = sampleSummary({ template: 'reit', headline: { revenue: { value: 412_500_000, unit: 'money' } }, kpis: [{ key: 'affoPerShare', label: 'AFFO per share', unit: 'perShare' }] });
    expect(scorecardRows(reit).map((row) => [row.label, row.actual, row.disclosed])).toEqual([
      ['AFFO per share', NOT_DISCLOSED, false],
      ['Revenue', '$412.5M', true],
    ]);
  });
});

const quarter = { symbol: 'NWND', quarterEnd: '2026-09-30', ticker: 'NWND', fetchedAt: '2026-10-12T06:20:00.000Z' };

describe('scorecardRows with the consensus', () => {
  it('writes the estimate with its range, the analysts, the source and the beat or miss with its amount', () => {
    const summary = attachConsensus(sampleSummary(), { quarters: [{ ...quarter, eps: { average: 6.45, high: 6.6, low: 6.3, analysts: 12 }, revenue: { average: 21_000_000_000, analysts: 1 } }] });
    const [eps, revenue] = scorecardRows(summary);
    expect(sp(eps!.expected)).toBe('US$ 6,45');
    expect([sp(eps!.range ?? ''), eps!.analysts, eps!.source, eps!.verdict, eps!.surprise]).toEqual(['Range US$ 6,30 to US$ 6,60', '12 analysts', 'Consensus: Alpha Vantage', 'beat', '+7,3%']);
    expect(sp(eps!.beat ?? '')).toBe('Beat by US$ 0,47 (7,3%)');
    expect(revenue).toMatchObject({ expected: '$21B', hasEstimate: true, analysts: '1 analyst', verdict: 'miss', beat: 'Missed by $290M (1,4%)' });
    expect(revenue!.range).toBeUndefined();
  });

  it('says In line without an amount, and names the other sources of an EPS estimate', () => {
    const inline = attachConsensus(sampleSummary(), { quarters: [{ ...quarter, eps: { average: 6.9 } }] });
    expect(scorecardRows(inline)[0]).toMatchObject({ verdict: 'inline', beat: 'In line' });
    const release = scorecardRows(attachConsensus(sampleSummary(), { quarters: [] }))[0]!;
    expect(release.source).toBe('Estimate: Alpha Vantage');
    const calendar = scorecardRows(attachConsensus(sampleSummary({ headline: { eps: { value: 1, unit: 'perShare' } } }), { quarters: [], calendar: [{ date: '2026-10-21', epsEstimate: 0.9 }] }))[0]!;
    expect(calendar.source).toBe('Calendar estimate: Alpha Vantage');
  });

  it('shows an estimate without a verdict when the figure was not disclosed', () => {
    const summary = attachConsensus(sampleSummary({ headline: {} }), { quarters: [{ ...quarter, eps: { average: 1 } }] });
    const row = scorecardRows(summary)[0]!;
    expect([row.hasEstimate, row.disclosed, row.verdict, row.beat]).toEqual([true, false, undefined, undefined]);
  });

  it('has no percentage for a zero estimate', () => {
    const summary = attachConsensus(sampleSummary({ headline: { eps: { value: 0.1, unit: 'perShare' } } }), { quarters: [{ ...quarter, eps: { average: 0 } }] });
    expect(sp(scorecardRows(summary)[0]!.beat ?? '')).toBe('Beat by US$ 0,10');
    expect(scorecardRows(summary)[0]!.surprise).toBeUndefined();
  });

  it('says n/a in the cells and, from the job record, the reason in words once (never the bare phrase)', () => {
    for (const reason of CONSENSUS_REASONS) {
      const summary = { ...sampleSummary({ headline: { revenue: { value: 1, unit: 'money' } } }), consensus: { provider: 'Alpha Vantage' as const, reason } };
      expect(scorecardRows(summary)[1]!.expected).toBe(NOT_AVAILABLE);
      expect(scorecardNote(summary, NOW)).toBe(reasonText(reason, undefined, undefined, NOW));
      expect(REASON_TEXT[reason]).not.toBe(NO_ESTIMATE);
    }
    expect(REASON_TEXT.pending).toBe('Fetched on the next free run');
    expect(REASON_TEXT['no-coverage']).toBe('Not covered by the data provider');
    expect(REASON_TEXT.premium).toBe('The free Alpha Vantage plan does not include estimates');
    expect(REASON_TEXT['rate-limited']).toBe('Alpha Vantage is limiting requests right now; the app retries automatically');
    expect(reasonText('error', 'the provider answered 503')).toBe('The last attempt to fetch it failed (the provider answered 503)');
    expect(reasonText('error')).toBe(REASON_TEXT.error);
    expect(reasonText('error', '')).toBe(REASON_TEXT.error);
    expect(reasonText('premium', 'ignored')).toBe(REASON_TEXT.premium);
    expect(reasonText('error', 'x'.repeat(200))).toBe(`${REASON_TEXT.error} (${'x'.repeat(120)}…)`);
  });

  it('says when the app asks again after a rate limit: the time today, the date and time another day, nothing without one', () => {
    const today = new Date(2026, 9, 29, 14, 20).toISOString();
    const tomorrow = new Date(2026, 9, 30, 2, 1).toISOString();
    expect(reasonText('rate-limited', undefined, today, NOW)).toBe('Alpha Vantage is limiting requests right now; the app retries automatically (next try after 14:20)');
    expect(reasonText('rate-limited', 'words', tomorrow, NOW)).toMatch(/\(next try after 30-10-2026, 02:01\)$/);
    expect(reasonText('rate-limited', undefined, undefined, NOW)).toBe(REASON_TEXT['rate-limited']);
    expect(reasonText('rate-limited', undefined, 'not a date', NOW)).toBe(REASON_TEXT['rate-limited']);
    expect(reasonText('premium', undefined, today, NOW)).toBe(REASON_TEXT.premium);
  });

  it('names the figures that lack an estimate when only some do, and has no note when none lacks one or there is no reason', () => {
    const partial = { ...sampleSummary({ headline: { eps: { value: 1, unit: 'perShare', estimate: 0.9 }, revenue: { value: 1, unit: 'money' } } }), consensus: { provider: 'Alpha Vantage' as const, reason: 'no-figure' as const } };
    expect(scorecardNote(partial, NOW)).toBe('Revenue: The data provider has no estimate for this figure');
    const both = { ...sampleSummary({ headline: { eps: { value: 1, unit: 'perShare' }, revenue: { value: 1, unit: 'money' } } }), consensus: { provider: 'Alpha Vantage' as const, reason: 'pending' as const } };
    expect(scorecardNote(both, NOW)).toBe('Fetched on the next free run');
    const full = { ...sampleSummary(), consensus: { provider: 'Alpha Vantage' as const, reason: 'pending' as const, eps: { average: 1, source: 'consensus' as const }, revenue: { average: 2, source: 'consensus' as const } } };
    expect(scorecardNote(full, NOW)).toBeUndefined();
    expect(scorecardNote(sampleSummary(), NOW)).toBeUndefined();
    expect(scorecardNote({ ...sampleSummary(), consensus: { provider: 'Alpha Vantage' as const } }, NOW)).toBeUndefined();
  });

  it('keeps the old wording for a summary without the consensus fields, and explains a figure the consensus does not cover', () => {
    expect(scorecardRows(sampleSummary())[1]!.expected).toBe(NO_ESTIMATE);
    const consensusOnly = { ...sampleSummary(), consensus: { provider: 'Alpha Vantage' as const } };
    expect(scorecardRows(consensusOnly)[1]!.expected).toBe(NO_ESTIMATE);
    const reit = { ...sampleSummary({ template: 'reit', headline: { revenue: { value: 1, unit: 'money' } }, kpis: [{ key: 'affoPerShare', label: 'AFFO per share', unit: 'perShare' }] }), consensus: { provider: 'Alpha Vantage' as const, reason: 'pending' as const } };
    expect(scorecardRows(reit)[0]!.expected).toBe('Consensus covers EPS and revenue only');
  });

  it('beatText reads the verdict, the amount and the percentage', () => {
    const show = (value: number) => `#${value}`;
    expect(beatText('beat', 0.5, 2, show)).toBe('Beat by #0.5 (2,0%)');
    expect(beatText('miss', -3, -4.25, show)).toBe('Missed by #3 (4,3%)');
    expect(beatText('miss', -3, undefined, show)).toBe('Missed by #3');
    expect(beatText('inline', 0, 0, show)).toBe('In line');
  });

  it('estimateOf falls back to the estimate the release was stored with', () => {
    const summary = sampleSummary();
    expect(estimateOf(summary, 'eps', summary.headline.eps)).toMatchObject({ average: 6.45, source: 'release', surprise: { verdict: 'beat', pct: 7.3 } });
    expect(estimateOf(summary, 'revenue', summary.headline.revenue)).toBeUndefined();
    const bare = { value: 2, unit: 'perShare' as const, estimate: 1 };
    expect(estimateOf(summary, 'eps', bare)).toEqual({ average: 1, source: 'release' });
  });
});

describe('growth lines', () => {
  it('lists year over year then quarter over quarter for the scorecard figures and free cash flow', () => {
    const texts = growthLines(sampleSummary()).map((line) => line.text);
    expect(texts).toEqual([
      'EPS up 12% YoY',
      'Revenue up 11% YoY',
      'Free cash flow up 16% YoY',
      'FCF per share up 19% YoY',
      'EPS up 3,2% QoQ',
      'Revenue up 4,1% QoQ',
      'Free cash flow up 5% QoQ',
      'FCF per share up 5,1% QoQ',
    ]);
  });

  it('has no free cash flow lines for a bank and none for a missing comparison; down and flat read right', () => {
    const lines = growthLines(bank!).map((line) => line.text);
    expect(lines).toEqual(['EPS up 12% YoY', 'Revenue up 3,9% YoY', 'EPS down 1,4% QoQ', 'Revenue up 1,2% QoQ']);
    const flat = sampleSummary({ headline: { eps: { value: 1, unit: 'perShare', yoyPct: 0, qoqPct: -12.4 } } });
    expect(growthLines(flat).map((line) => line.text)).toEqual(['EPS flat YoY', 'EPS down 12% QoQ']);
    expect(growthLines(sampleSummary({ headline: {} }))).toEqual([]);
  });

  it('knows the first stored quarter', () => {
    expect(hasQuarterComparison(saas!)).toBe(false);
    expect(hasQuarterComparison(bank!)).toBe(true);
    expect(FIRST_QUARTER_NOTE).toBe('n/a, first stored quarter');
  });
});

describe('lookups', () => {
  it('finds a headline figure or a template slot, and labels both', () => {
    expect(metricOf(saas!, 'rpo')?.value).toBe(14_800_000_000);
    expect(metricOf(saas!, 'arr')).toBeUndefined();
    expect(metricOf(saas!, 'revenue')?.unit).toBe('money');
    expect(labelOf(saas!, 'nrr')).toBe('Net revenue retention');
    expect(labelOf(saas!, 'fcfPerShare')).toBe('FCF per share');
    expect(labelOf(saas!, 'mystery')).toBe('mystery');
  });

  it('lists the changes of a metric and the release words of a guidance', () => {
    expect(changeParts({ value: 1, unit: 'percent', yoyPoints: 1.1, qoqPoints: -0.2, yoyPct: -3, qoqPct: 4 })).toEqual([
      { text: '−3,0%', period: 'yoy', negative: true },
      { text: '+1,1 pt', period: 'yoy', negative: false },
      { text: '+4,0%', period: 'qoq', negative: false },
      { text: '-0,2 pt', period: 'qoq', negative: true },
    ]);
    expect(guidanceText(sampleSummary().guidance[0]!)).toBe('$80.0 billion to $81.5 billion');
  });
});
