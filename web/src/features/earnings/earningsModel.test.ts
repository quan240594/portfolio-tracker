import { describe, expect, it } from 'vitest';
import { sampleDemoSummaries, sampleSummary } from '@portfolio/shared';
import { sp } from '../../test/utils';
import { FIRST_QUARTER_NOTE, NOT_DISCLOSED, NO_ESTIMATE, changeParts, compactCount, formatGrowth, formatMetric, formatPoints, growthLines, guidanceText, hasQuarterComparison, labelOf, metricOf, scorecardRows } from './earningsModel';

const [bank, saas] = sampleDemoSummaries();

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
