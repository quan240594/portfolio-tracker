/**
 * INVENTED sample summaries: fictional companies and made-up numbers, for the public demo (mock mode) and for tests. Nothing here is a real
 * company's result.
 */
import { attachConsensus, type ConsensusFigure, type ConsensusState } from './earnings-consensus.js';
import { EARNINGS_SCHEMA_VERSION, KPI_TEMPLATES, KPI_TEMPLATE_IDS, type EarningsKpi, type EarningsMetric, type EarningsSummary, type KpiTemplateId } from './earnings.js';

const metric = (value: number, unit: EarningsMetric['unit'], extra: Partial<EarningsMetric> = {}): EarningsMetric => ({ value, unit, ...extra });

/** A complete generic-template summary of the fictional "Northwind Aerospace" for the quarter that ended 30-09-2026. */
export function sampleSummary(overrides: Partial<EarningsSummary> = {}): EarningsSummary {
  return {
    schemaVersion: EARNINGS_SCHEMA_VERSION,
    symbol: 'NWND',
    name: 'Northwind Aerospace Corporation',
    period: 'Q3 2026',
    reportDate: '2026-10-21',
    filingUrl: 'https://www.sec.gov/Archives/edgar/data/1000001/000100000126000001/ex99_1.htm',
    accession: '0001000001-26-000001',
    form: '8-K',
    reportingCurrency: 'USD',
    template: 'generic',
    origin: 'live',
    headline: {
      eps: metric(6.92, 'perShare', { raw: '$6.92', yearAgo: 6.2, yoyPct: 11.6, qoqPct: 3.2, estimate: 6.45, surprisePct: 7.3, verdict: 'beat', basis: 'adjusted' }),
      revenue: metric(20_710_000_000, 'money', { raw: '$20.71 billion', yearAgo: 18_660_000_000, yoyPct: 11, qoqPct: 4.1 }),
      operatingIncome: metric(2_380_000_000, 'money', { raw: '$2.38 billion', yearAgo: 2_150_000_000, yoyPct: 10.7 }),
      operatingMargin: metric(11.5, 'percent', { yearAgo: 11.5, yoyPoints: 0, basis: 'calculated' }),
      operatingCashFlow: metric(3_100_000_000, 'money', { raw: '$3.1 billion', yearAgo: 2_700_000_000, yoyPct: 14.8 }),
      capex: metric(540_000_000, 'money', { raw: '$540 million', yearAgo: 500_000_000, yoyPct: 8 }),
      fcf: metric(2_560_000_000, 'money', { yearAgo: 2_200_000_000, yoyPct: 16.4, qoqPct: 5, basis: 'calculated' }),
      fcfPerShare: metric(10.67, 'perShare', { yearAgo: 9, yoyPct: 18.6, qoqPct: 5.1, basis: 'calculated' }),
      dilutedShares: metric(240_000_000, 'count', { raw: '240.0 million' }),
    },
    kpis: [],
    guidance: [
      { label: 'Net sales', period: 'full year 2026', unit: 'money', low: 80_000_000_000, high: 81_500_000_000, raw: '$80.0 billion to $81.5 billion', direction: 'raised' },
      { label: 'Segment operating profit', period: 'full year 2026', unit: 'money', point: 8_900_000_000, raw: 'about $8.9 billion', direction: 'maintained' },
    ],
    segments: [
      { name: 'Airframes', value: 7_400_000_000, raw: '$7.4 billion', yearAgo: 6_700_000_000, yoyPct: 10.4 },
      { name: 'Precision Systems', value: 3_800_000_000, raw: '$3.8 billion', yearAgo: 3_100_000_000, yoyPct: 22.6 },
      { name: 'Space', value: 3_300_000_000, raw: '$3.3 billion', yearAgo: 3_300_000_000, yoyPct: 0 },
    ],
    keyUpdates: ['Backlog reached a record $170 billion', 'Raised full-year sales outlook', 'Delivered 42 aircraft in the quarter'],
    quote: { text: 'We delivered strong results and raised our outlook for the year.', speaker: 'Chief Executive Officer' },
    previousReportDate: '2026-07-22',
    verification: { dropped: 0, droppedFields: [], model: '@cf/meta/llama-3.1-8b-instruct-fp8', neuronsEstimate: 250, calls: 1 },
    generatedAt: '2026-10-21T21:10:00.000Z',
    status: 'ok',
    ...overrides,
  };
}

const kpisOf = (template: KpiTemplateId, values: Readonly<Record<string, EarningsMetric>>): EarningsKpi[] =>
  KPI_TEMPLATES[template].slots.map((slot) => ({ key: slot.key, label: slot.label, unit: slot.unit, ...(values[slot.key] === undefined ? {} : { metric: values[slot.key] }) }));

/** An invented consensus joined to a sample summary, as the API does it (the quarter that ended on `quarterEnd`). */
function withSampleConsensus(summary: EarningsSummary, quarterEnd: string, figures: { eps?: ConsensusFigure; revenue?: ConsensusFigure }, state?: ConsensusState): EarningsSummary {
  const quarter = { symbol: summary.symbol, quarterEnd, ticker: summary.symbol, fetchedAt: '2026-10-12T06:20:00.000Z', ...figures };
  return attachConsensus(summary, { quarters: [quarter], state });
}

/** The two summaries the demo shows: a software company and a bank, both fictional, with invented analyst estimates. */
export function sampleDemoSummaries(): EarningsSummary[] {
  const saasBase = sampleSummary({
    symbol: 'CLDV',
    name: 'Cloudvale Software Inc.',
    period: 'Q2 FY2027',
    reportDate: '2026-10-14',
    accession: '0001000002-26-000002',
    template: 'saas',
    origin: 'backfill',
    headline: {
      eps: metric(2.1, 'perShare', { raw: '$2.10', yearAgo: 1.61, yoyPct: 30.4, qoqPct: 8.2, basis: 'adjusted' }),
      revenue: metric(3_120_000_000, 'money', { raw: '$3.12 billion', yearAgo: 2_010_000_000, yoyPct: 55.2, qoqPct: 17 }),
      fcf: metric(910_000_000, 'money', { raw: '$910 million', yearAgo: 640_000_000, yoyPct: 42.2, basis: 'reported' }),
      fcfPerShare: metric(2.28, 'perShare', { yearAgo: 1.6, yoyPct: 42.5, basis: 'calculated' }),
      dilutedShares: metric(399_000_000, 'count', { raw: '399 million' }),
    },
    kpis: kpisOf('saas', {
      rpo: metric(14_800_000_000, 'money', { raw: '$14.8 billion', yearAgo: 11_300_000_000, yoyPct: 31 }),
      crpo: metric(27, 'percent', { raw: '27%' }),
      nrr: metric(118, 'percent', { raw: '118%' }),
    }),
    guidance: [{ label: 'Revenue', period: 'full year', unit: 'money', low: 12_100_000_000, high: 12_300_000_000, raw: '$12.1 billion to $12.3 billion', direction: 'new' }],
    segments: [],
    keyUpdates: ['Added 1,900 customers above $1 million', 'Announced a new AI assistant for subscribers'],
    quote: undefined,
    previousReportDate: undefined,
    verification: { dropped: 1, droppedFields: ['quote'], model: '@cf/meta/llama-3.1-8b-instruct-fp8', neuronsEstimate: 310, calls: 1 },
    generatedAt: '2026-10-14T20:30:00.000Z',
  });
  const bankBase = sampleSummary({
    symbol: 'HBRB',
    name: 'Harbor Bancorp',
    period: 'Q3 2026',
    reportDate: '2026-10-16',
    accession: '0001000003-26-000003',
    template: 'bank',
    origin: 'live',
    headline: {
      eps: metric(4.88, 'perShare', { raw: '$4.88', yearAgo: 4.37, yoyPct: 11.7, qoqPct: -1.4, estimate: 4.9, surprisePct: -0.4, verdict: 'inline', basis: 'GAAP' }),
      revenue: metric(13_400_000_000, 'money', { raw: '$13.4 billion', yearAgo: 12_900_000_000, yoyPct: 3.9, qoqPct: 1.2 }),
    },
    kpis: kpisOf('bank', {
      rotce: metric(17.2, 'percent', { raw: '17.2%', yearAgo: 16.1, yoyPoints: 1.1 }),
      tbvps: metric(61.4, 'perShare', { raw: '$61.40', yearAgo: 54.9, yoyPct: 11.8 }),
      cet1: metric(15.1, 'percent', { raw: '15.1%' }),
      netInterestIncome: metric(7_100_000_000, 'money', { raw: '$7.1 billion', yearAgo: 6_800_000_000, yoyPct: 4.4 }),
      efficiencyRatio: metric(55, 'percent', { raw: '55%' }),
    }),
    guidance: [],
    segments: [{ name: 'Consumer banking', value: 5_200_000_000, raw: '$5.2 billion', yearAgo: 4_900_000_000, yoyPct: 6.1 }],
    keyUpdates: ['Net interest income guidance unchanged', 'Repurchased $1.5 billion of common stock'],
    quote: { text: 'Our balance sheet is strong and our customers remain resilient.', speaker: 'Chair and CEO' },
    verification: { dropped: 0, droppedFields: [], model: '@cf/meta/llama-3.1-8b-instruct-fp8', neuronsEstimate: 280, calls: 1 },
    generatedAt: '2026-10-16T11:05:00.000Z',
  });
  const saas = withSampleConsensus(saasBase, '2026-09-30', {
    eps: { average: 1.95, high: 2.02, low: 1.88, analysts: 31 },
    revenue: { average: 3_180_000_000, high: 3_240_000_000, low: 3_100_000_000, analysts: 27 },
  });
  const bank = withSampleConsensus(
    bankBase,
    '2026-09-30',
    { eps: { average: 4.9, high: 5.02, low: 4.78, analysts: 14 } },
    { symbol: 'HBRB', outcome: 'ok', at: '2026-10-12T06:20:00.000Z', fetchedAt: '2026-10-12T06:20:00.000Z', ticker: 'HBRB', quarters: 1, updatedAt: '2026-10-12T06:20:00.000Z' },
  );
  return [bank, saas];
}

/** One invented summary per KPI template (every second slot filled, the others left empty) for visual checks of all templates. */
export function sampleTemplateSummaries(): EarningsSummary[] {
  return KPI_TEMPLATE_IDS.map((template, index) =>
    sampleSummary({
      symbol: `TPL${index}`,
      name: `Template ${template} Company`,
      template,
      kpis: KPI_TEMPLATES[template].slots.map((slot, i) => ({
        key: slot.key,
        label: slot.label,
        unit: slot.unit,
        ...(i % 2 === 0 ? { metric: metric(slot.unit === 'money' ? 1_200_000_000 : 12.5, slot.unit, { yoyPct: 7.5 }) } : {}),
      })),
    }),
  );
}
