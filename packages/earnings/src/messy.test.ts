import { describe, expect, it } from 'vitest';
import { deriveSummary } from './derive.js';
import { extractionSchema } from './schema.js';
import { looksLikeResults } from './sec.js';
import { htmlToText } from './text.js';
import { hasHeadline, verifyExtraction } from './verify.js';
import { FOREIGN_TEXT_RELEASE, IXBRL_BANK_RELEASE, IXBRL_RELEASE, MESSY_RELEASES, MESSY_REIT_RELEASE, PROSE_SAAS_RELEASE } from './testing/messy-fixtures.js';
import type { FixtureRelease } from './testing/fixtures.js';

const NOW = new Date('2026-10-29T08:00:00.000Z');

function build(release: FixtureRelease) {
  const text = htmlToText(release.html);
  const { verified, dropped } = verifyExtraction(extractionSchema.parse(release.extraction), text, release.template);
  const summary = deriveSummary({
    verified,
    dropped,
    symbol: release.symbol,
    name: release.name,
    template: release.template,
    filing: { url: 'https://www.sec.gov/Archives/edgar/data/1/1/x.htm', accession: release.accession, form: release.form, reportDate: release.filingDate },
    origin: 'live',
    model: 'test-model',
    neurons: 100,
    calls: 1,
    now: NOW,
  });
  return { text, verified, dropped, summary };
}

describe('messy invented releases', () => {
  it.each(MESSY_RELEASES.map((release) => [release.symbol, release] as const))('%s: reads like results and every faithful figure verifies', (_symbol, release) => {
    const { text, dropped, verified } = build(release);
    expect(looksLikeResults(text, release.form)).toBe(true);
    expect(dropped).toEqual([]);
    expect(hasHeadline(verified)).toBe(true);
  });

  it('inline XBRL: the hidden header and the display:none block never reach the text', () => {
    const text = htmlToText(IXBRL_RELEASE.html);
    expect(text).not.toContain('999');
    expect(text).not.toContain('88.88');
    expect(text).not.toContain('Tracking pixel');
    expect(text).not.toContain('xbrli');
    expect(text).toContain('Kernel Dynamics Announces Fiscal Third Quarter 2026 Results');
  });

  it('thousands table with signs in cells of their own: values scale to whole dollars, capex is read as an outflow amount', () => {
    const { summary } = build(IXBRL_RELEASE);
    expect(summary.headline.revenue).toMatchObject({ value: 812_400_000, yearAgo: 745_300_000, yoyPct: 9 });
    expect(summary.headline.operatingIncome?.value).toBe(118_900_000);
    expect(summary.headline.eps).toMatchObject({ value: 0.62, basis: 'GAAP', yearAgo: 0.55 });
    expect(summary.headline.dilutedShares?.value).toBe(155_100_000);
    expect(summary.headline.fcf).toMatchObject({ value: 109_100_000, basis: 'calculated' });
  });

  it('a hallucinated figure that only exists in the hidden header is dropped', () => {
    const text = htmlToText(IXBRL_RELEASE.html);
    const forged = extractionSchema.parse({ ...IXBRL_RELEASE.extraction, revenue: { value: '999,999,999' }, epsGaap: { value: '$88.88' } });
    const { verified, dropped } = verifyExtraction(forged, text, 'generic');
    expect(verified.revenue).toBeUndefined();
    expect(dropped.toSorted((a, b) => a.localeCompare(b))).toEqual(['epsGaap.value', 'revenue.value']);
  });

  it('6-K plain text: euro amounts in prose and percentages as words', () => {
    const { summary } = build(FOREIGN_TEXT_RELEASE);
    expect(summary.reportingCurrency).toBe('EUR');
    expect(summary.headline.revenue).toMatchObject({ value: 7_120_000_000, yoyPct: 8.7 });
    expect(summary.headline.operatingMargin).toMatchObject({ value: 36.7 });
    expect(summary.headline.eps).toMatchObject({ value: 5.21, yearAgo: 4.76 });
  });

  it('bank: dollar signs in separate cells and a ratio printed as 21 | % are still found', () => {
    const { summary, dropped } = build(IXBRL_BANK_RELEASE);
    expect(dropped).toEqual([]);
    expect(summary.headline.revenue?.value).toBe(46_200_000_000);
    expect(summary.kpis.find((kpi) => kpi.key === 'cet1')?.metric?.value).toBe(15.3);
    expect(summary.kpis.find((kpi) => kpi.key === 'rotce')?.metric).toMatchObject({ value: 21, yearAgo: 20 });
  });

  it('REIT: FFO and AFFO per share, occupancy and guidance range', () => {
    const { summary } = build(MESSY_REIT_RELEASE);
    expect(summary.kpis.map((kpi) => [kpi.key, kpi.metric?.value])).toEqual(expect.arrayContaining([['ffoPerShare', 1.52], ['affoPerShare', 1.47]]));
    expect(summary.guidance[0]).toMatchObject({ low: 5.8, high: 5.88 });
  });

  it('SaaS prose without tables: figures split into spans are joined', () => {
    const { summary, text } = build(PROSE_SAAS_RELEASE);
    expect(text).toContain('Total revenue was $5.46 billion');
    expect(summary.headline.revenue?.value).toBe(5_460_000_000);
    expect(summary.headline.eps).toMatchObject({ value: 4.82, basis: 'adjusted' });
    expect(summary.headline.operatingMargin).toMatchObject({ value: 33.1, yearAgo: 32.4 });
  });
});
