import { describe, expect, it } from 'vitest';
import { extractionSchema } from './schema.js';
import { htmlToText } from './text.js';
import { looksLikeResults } from './sec.js';
import { verifyExtraction, hasHeadline } from './verify.js';
import { deriveSummary } from './derive.js';
import { ALL_RELEASES, BANK_RELEASE, FOREIGN_RELEASE, GENERIC_RELEASE, INFRA_RELEASE, REIT_RELEASE, SAAS_RELEASE, type FixtureRelease } from './testing/fixtures.js';

const NOW = new Date('2026-10-22T08:00:00.000Z');

function build(release: FixtureRelease) {
  const text = htmlToText(release.html);
  const extraction = extractionSchema.parse(release.extraction);
  const { verified, dropped } = verifyExtraction(extraction, text, release.template);
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

describe('the invented releases', () => {
  it.each(ALL_RELEASES.map((release) => [release.symbol, release] as const))('%s reads like results and every faithful value verifies', (_symbol, release) => {
    const { text, dropped, verified } = build(release);
    expect(looksLikeResults(text)).toBe(true);
    expect(dropped).toEqual([]);
    expect(hasHeadline(verified)).toBe(true);
  });

  it('generic: growth, FCF (calculated), FCF per share, margin and guidance', () => {
    const { summary } = build(GENERIC_RELEASE);
    const h = summary.headline;
    expect(summary.reportingCurrency).toBe('USD');
    expect(summary.period).toBe('Q3 2026');
    expect(h.eps).toMatchObject({ value: 1.98, basis: 'adjusted', yearAgo: 1.71, yoyPct: 15.8 });
    expect(h.revenue).toMatchObject({ value: 4_820_000_000, yearAgo: 4_303_000_000, yoyPct: 12 });
    expect(h.operatingMargin).toMatchObject({ basis: 'calculated', value: 21.16, yearAgo: 21.03, yoyPoints: 0.1 });
    expect(h.fcf).toMatchObject({ value: 1_000_000_000, basis: 'calculated', yearAgo: 855_000_000, yoyPct: 17 });
    expect(h.fcfPerShare).toMatchObject({ value: 1.3193, basis: 'calculated' });
    expect(h.fcfPerShare?.yearAgo).toBeCloseTo(855 / 770, 4);
    expect(summary.guidance).toEqual([expect.objectContaining({ low: 18_900_000_000, high: 19_100_000_000, unit: 'money', raw: '$18.9 billion to $19.1 billion' })]);
    expect(summary.guidance[0]!.direction).toBeUndefined();
    expect(summary.quote?.text).toContain('record cloud demand');
    expect(summary.keyUpdates).toHaveLength(2);
    expect(summary.kpis).toEqual([]);
  });

  it('reit: AFFO and FFO per share, occupancy, no free cash flow', () => {
    const { summary } = build(REIT_RELEASE);
    expect(summary.kpis.map((kpi) => [kpi.key, kpi.metric?.value])).toEqual([
      ['affoPerShare', 1.12],
      ['ffoPerShare', 1.08],
      ['occupancy', 97.4],
      ['sameStoreNoi', 3.1],
    ]);
    expect(summary.kpis[0]!.metric).toMatchObject({ yearAgo: 1.05, yoyPct: 6.7 });
    expect(summary.headline.fcf).toBeUndefined();
    expect(summary.headline.revenue?.yoyPct).toBe(6);
    expect(summary.guidance[0]).toMatchObject({ low: 4.38, high: 4.44, unit: 'perShare' });
  });

  it('bank: the template slots and no free cash flow', () => {
    const { summary } = build(BANK_RELEASE);
    const byKey = Object.fromEntries(summary.kpis.map((kpi) => [kpi.key, kpi.metric]));
    expect(byKey.rotce).toMatchObject({ value: 18.5, yearAgo: 17.1, yoyPoints: 1.4 });
    expect(byKey.tbvps).toMatchObject({ value: 38.4, yoyPct: 10 });
    expect(byKey.cet1?.value).toBe(13.2);
    expect(byKey.netInterestIncome).toMatchObject({ value: 3_100_000_000, yoyPct: 6.9 });
    expect(byKey.provisionForCreditLosses?.value).toBe(210_000_000);
    expect(summary.headline.fcf).toBeUndefined();
    expect(summary.headline.eps).toMatchObject({ basis: 'GAAP', yoyPct: 11.4 });
  });

  it('saas: reported free cash flow and per-share', () => {
    const { summary } = build(SAAS_RELEASE);
    expect(summary.headline.fcf).toMatchObject({ value: 412_000_000, basis: 'reported', yoyPct: 29.6 });
    expect(summary.headline.fcfPerShare?.value).toBeCloseTo(412 / 301, 3);
    expect(summary.headline.revenue).toMatchObject({ value: 1_640_000_000, yearAgo: 1_322_000_000 });
    expect(summary.kpis.map((kpi) => kpi.key)).toEqual(['rpo', 'crpo', 'arr', 'nrr', 'seats']);
    expect(summary.kpis.find((kpi) => kpi.key === 'arr')?.metric).toBeUndefined();
    expect(summary.kpis.find((kpi) => kpi.key === 'seats')?.metric?.value).toBe(17);
  });

  it('infra: calculated free cash flow, backlog and cloud revenue', () => {
    const { summary } = build(INFRA_RELEASE);
    expect(summary.headline.fcf).toMatchObject({ value: 710_000_000, basis: 'calculated' });
    expect(summary.headline.eps).toMatchObject({ value: 2.62, basis: 'adjusted' });
    const rpo = summary.kpis.find((kpi) => kpi.key === 'rpo')!;
    expect(rpo.metric?.value).toBe(52_400_000_000);
    expect(summary.kpis.find((kpi) => kpi.key === 'cloudRevenue')?.metric?.yoyPct).toBe(40.8);
    expect(summary.guidance[0]).toMatchObject({ point: 10_000_000_000, raw: '$10.0 billion' });
  });

  it('foreign 6-K: reports in euros and never converts', () => {
    const { summary } = build(FOREIGN_RELEASE);
    expect(summary.reportingCurrency).toBe('EUR');
    expect(summary.form).toBe('6-K');
    expect(summary.headline.revenue).toMatchObject({ value: 6_200_000_000, yearAgo: 5_540_000_000 });
    expect(summary.headline.operatingMargin).toMatchObject({ value: 33 });
    expect(summary.headline.operatingMargin).not.toHaveProperty('basis');
    expect(summary.headline.eps?.value).toBe(4.85);
  });
});
