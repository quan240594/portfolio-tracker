import { describe, expect, it } from 'vitest';
import {
  CORE_METRIC_KEYS,
  CORE_METRIC_META,
  EARNINGS_DISCLAIMER,
  EARNINGS_SCHEMA_VERSION,
  KPI_TEMPLATES,
  KPI_TEMPLATE_IDS,
  earningsKeys,
  earningsListQuerySchema,
  earningsPeriodSchema,
  isKpiTemplateId,
  type EarningsSummary,
} from './earnings.js';
import { CURATED_TEMPLATE_TICKERS, hasEarnings, kpiTemplateFor } from './earnings-templates.js';
import { buildEarningsNotification, formatCompactMoney, formatEarningsPct, formatMetricValue } from './earnings-format.js';
import { SAMPLE_EPS_ONLY_ENDPOINT, sampleDemoSummaries, sampleDemoSummariesEpsOnly, sampleSummary, sampleTemplateSummaries } from './earnings-sample.js';
import { baselineEntries, detectDueNotifications, ledgerId, type DetectInput } from './notification-events.js';
import { defaultNotificationSettings, effectiveNotificationSettings } from './notifications.js';
import { classificationFieldsOf, classificationPutSchema, hasClassification } from './classification.js';
import type { Transaction } from './types.js';

describe('templates', () => {
  it('defines the five templates with the slots the owner asked for', () => {
    expect(KPI_TEMPLATE_IDS).toEqual(['generic', 'reit', 'bank', 'saas', 'infra']);
    expect(KPI_TEMPLATES.reit.slots.map((slot) => slot.key)).toEqual(['affoPerShare', 'ffoPerShare', 'occupancy', 'sameStoreNoi']);
    expect(KPI_TEMPLATES.reit.scorecard).toEqual(['affoPerShare', 'revenue']);
    expect(KPI_TEMPLATES.bank.slots.map((slot) => slot.key)).toEqual(['rotce', 'tbvps', 'cet1', 'netInterestIncome', 'efficiencyRatio', 'provisionForCreditLosses']);
    expect(KPI_TEMPLATES.saas.slots.map((slot) => slot.key)).toEqual(['rpo', 'crpo', 'arr', 'nrr', 'seats']);
    expect(KPI_TEMPLATES.infra.slots.map((slot) => slot.key)).toEqual(['rpo', 'cloudRevenue', 'cloudGrowth', 'capexKpi']);
    expect(KPI_TEMPLATES.generic.slots).toEqual([]);
  });

  it('shows free cash flow for generic, SaaS and infrastructure only', () => {
    expect(KPI_TEMPLATE_IDS.filter((id) => KPI_TEMPLATES[id].showFcf)).toEqual(['generic', 'saas', 'infra']);
    expect(KPI_TEMPLATE_IDS.every((id) => KPI_TEMPLATES[id].slots.every((slot) => slot.hint.length > 0 && slot.label.length > 0))).toBe(true);
    expect(CORE_METRIC_KEYS.every((key) => CORE_METRIC_META[key].label.length > 0)).toBe(true);
  });

  it('recognises template ids and keys summaries beside, not inside, the calendar events', () => {
    expect(isKpiTemplateId('bank')).toBe(true);
    expect(isKpiTemplateId('tech')).toBe(false);
    expect(isKpiTemplateId(undefined)).toBe(false);
    expect(earningsKeys.summary('LMT', '2026-10-21')).toEqual({ PK: 'TICKER#LMT', SK: 'EARNSUM#2026-10-21' });
    expect(earningsKeys.summaryPrefix.startsWith('EARN#')).toBe(false);
    expect(EARNINGS_DISCLAIMER).toContain('every number was checked against the text');
  });
});

describe('kpiTemplateFor', () => {
  it('picks by override, then the curated table (also for exchange-suffixed symbols), then the sector', () => {
    expect(kpiTemplateFor({ symbol: 'JPM', assetClass: 'STOCK', sector: 'Financial Services' })).toBe('bank');
    expect(kpiTemplateFor({ symbol: 'O', assetClass: 'STOCK' })).toBe('reit');
    expect(kpiTemplateFor({ symbol: 'CRM', assetClass: 'STOCK' })).toBe('saas');
    expect(kpiTemplateFor({ symbol: 'MSFT', assetClass: 'STOCK' })).toBe('infra');
    expect(kpiTemplateFor({ symbol: 'ABC.AS', assetClass: 'STOCK', sector: 'Real Estate' })).toBe('reit');
    expect(kpiTemplateFor({ symbol: 'MSFT', assetClass: 'STOCK', override: 'generic' })).toBe('generic');
    expect(kpiTemplateFor({ symbol: 'AAPL', assetClass: 'STOCK', sector: 'Technology', override: 'nonsense' })).toBe('generic');
    expect(kpiTemplateFor({ symbol: 'ZZZZ', assetClass: 'STOCK' })).toBe('generic');
    expect(CURATED_TEMPLATE_TICKERS).toBeGreaterThan(30);
  });

  it('has none for instruments without earnings', () => {
    for (const assetClass of ['ETF', 'CRYPTO', 'BOND', 'CASH', 'COMMODITY', 'REAL_ESTATE'] as const) {
      expect(kpiTemplateFor({ symbol: 'JPM', assetClass, override: 'bank' })).toBeNull();
      expect(hasEarnings(assetClass)).toBe(false);
      expect(hasEarnings(assetClass, 'Some Company')).toBe(false);
    }
    expect(hasEarnings('STOCK')).toBe(true);
  });

  it('an unknown class (no profile yet, or the placeholder OTHER) counts unless the name reads like a fund', () => {
    for (const assetClass of ['OTHER', undefined] as const) {
      expect(hasEarnings(assetClass)).toBe(true);
      expect(hasEarnings(assetClass, 'Salesforce')).toBe(true);
      expect(hasEarnings(assetClass, 'Vanguard FTSE All-World UCITS ETF')).toBe(false);
      expect(hasEarnings(assetClass, 'iShares Physical Gold')).toBe(false);
      expect(hasEarnings(assetClass, 'Bitcoin')).toBe(false);
      expect(hasEarnings(assetClass, 'Harborstone Realty Trust')).toBe(true);
      expect(hasEarnings(assetClass, 'Barrick Gold Corporation')).toBe(true);
      expect(kpiTemplateFor({ symbol: 'FOO.DE', assetClass, name: 'Salesforce' })).toBe('saas');
      expect(kpiTemplateFor({ symbol: 'VWRL.L', assetClass, name: 'Vanguard FTSE All-World UCITS ETF' })).toBeNull();
    }
  });
});

describe('number formats', () => {
  it.each([
    [20_710_000_000, 'USD', '$20.71B'],
    [5_200_000_000, 'USD', '$5.2B'],
    [850_000_000, 'EUR', '€850M'],
    [12_500_000, 'GBP', '£12.5M'],
    [1234, 'USD', '$1.2K'],
    [-300_000_000, 'USD', '-$300M'],
    [2_100_000_000_000, 'USD', '$2.1T'],
    [12.5, 'USD', '$12.5'],
    [5, 'CHF', 'CHF 5'],
    [5, 'SEK', 'SEK 5'],
  ])('%s %s -> %s', (value, currency, text) => {
    expect(formatCompactMoney(value, currency)).toBe(text);
  });

  it('prints signed percentages', () => {
    expect(formatEarningsPct(11.04)).toBe('+11 %');
    expect(formatEarningsPct(7.34)).toBe('+7.3 %');
    expect(formatEarningsPct(-3.46)).toBe('-3.5 %');
    expect(formatEarningsPct(0)).toBe('0 %');
  });

  it('formats a metric by its unit', () => {
    expect(formatMetricValue({ value: 3.1e9, unit: 'money' }, 'USD')).toBe('$3.1B');
    expect(formatMetricValue({ value: 1.12, unit: 'perShare' }, 'USD')).toBe('$1.12');
    expect(formatMetricValue({ value: 18.5, unit: 'percent' }, 'USD')).toBe('18.5 %');
    expect(formatMetricValue({ value: 2.456, unit: 'ratio' }, 'USD')).toBe('2.46x');
    expect(formatMetricValue({ value: 758_000_000, unit: 'count' }, 'USD')).toBe('758000000');
  });
});

describe('buildEarningsNotification', () => {
  it('words the owner\'s example: EPS beat by 7 %, revenue with YoY, FCF per share, guidance raised', () => {
    const message = buildEarningsNotification(sampleSummary({ name: 'Lockheed Martin Corporation', symbol: 'LMT', period: 'Q3 2026' }));
    expect(message.payload).toEqual({
      type: 'earnings',
      symbol: 'LMT',
      title: 'Lockheed Martin reported Q3 2026: EPS beat by 7.3 %',
      body: 'Revenue $20.71B +11 % YoY · FCF/share $10.67 · guidance raised',
      url: '/earnings/LMT',
      tag: 'earnings:LMT:2026-10-21',
    });
    expect(message.line).toBe('Lockheed Martin reported Q3 2026 (EPS beat by 7.3 %)');
  });

  it('leaves out what is not available and uses the template key figure', () => {
    const [bank, saas] = sampleDemoSummaries();
    const bankMessage = buildEarningsNotification(bank!);
    expect(bankMessage.payload.title).toBe('Harbor Bancorp reported Q3 2026: EPS in line');
    expect(bankMessage.payload.body).toBe('Revenue $13.4B +3.9 % YoY · ROTCE 17.2 % · dividend raised 4.2 %');
    const saasMessage = buildEarningsNotification(saas!);
    expect(saasMessage.payload.title).toBe('Cloudvale Software reported Q2 FY2027');
    expect(saasMessage.payload.body).toBe('Revenue $3.12B +55 % YoY · FCF/share $2.28');
    const bare = buildEarningsNotification(sampleSummary({ headline: {}, kpis: [], guidance: [] }));
    expect(bare.payload.body).toBe('The earnings summary is ready.');
    const miss = buildEarningsNotification(sampleSummary({ headline: { eps: { value: 1, unit: 'perShare', verdict: 'miss', surprisePct: -12.4 } }, guidance: [{ label: 'x', unit: 'money', raw: 'x', direction: 'lowered' }] }));
    expect(miss.payload.title).toContain('EPS missed by 12 %');
    expect(miss.payload.body).toContain('guidance lowered');
    const noPct = buildEarningsNotification(sampleSummary({ headline: { eps: { value: 1, unit: 'perShare', verdict: 'beat' } } }));
    expect(noPct.payload.title).toMatch(/EPS beat$/);
  });

  it('mentions a dividend that changed with the results, and nothing for a steady, absent or unread one', () => {
    const body = (dividend: EarningsSummary['dividend']): string => buildEarningsNotification(sampleSummary({ guidance: [], dividend })).payload.body;
    const base = { status: 'announced' as const, perShare: 0.3, currency: 'USD' };
    expect(body({ ...base, action: 'cut', changePct: -50 })).toBe('Revenue $20.71B +11 % YoY · FCF/share $10.67 · dividend cut 50 %');
    expect(body({ ...base, action: 'suspended' })).toContain('· dividend suspended');
    expect(body({ ...base, action: 'initiated', changePct: 0 })).toContain('· dividend initiated');
    expect(body({ ...base, action: 'maintained', changePct: 0 })).not.toContain('dividend');
    expect(body(base)).not.toContain('dividend');
    expect(body({ status: 'none' })).not.toContain('dividend');
    expect(body(undefined)).not.toContain('dividend');
  });

  it('caps the title and body', () => {
    const long = buildEarningsNotification(sampleSummary({ name: 'X'.repeat(300), period: 'P'.repeat(200) }));
    expect(long.payload.title.length).toBeLessThanOrEqual(90);
  });
});

describe('earnings notifications in the detection', () => {
  const TODAY = '2026-10-22';
  const held = (symbol: string): Transaction => ({ id: `t-${symbol}`, userId: 'u', portfolioId: 'p', date: '2025-01-10', type: 'BUY', symbol, quantity: 5, price: 10, fee: 0, currency: 'USD', createdAt: '2025-01-10T00:00:00Z' });
  const base = (extra: Partial<DetectInput>): DetectInput => ({
    today: TODAY,
    settings: defaultNotificationSettings(),
    baseCurrency: 'EUR',
    transactions: [held('NWND'), held('CLDV')],
    dividendEvents: [],
    names: {},
    fx: null,
    notified: new Set(),
    ...extra,
  });

  it('announces a fresh live summary of a held symbol once, and not twice', () => {
    const live = sampleSummary({ symbol: 'NWND', reportDate: '2026-10-21' });
    expect(detectDueNotifications(base({ earnings: [live] })).due.map((due) => due.id)).toEqual(['earnings#NWND#2026-10-21']);
    expect(detectDueNotifications(base({ earnings: [live], notified: new Set([ledgerId('earnings', 'NWND', '2026-10-21')]) })).due).toEqual([]);
  });

  it('records backfilled and stale summaries silently and ignores symbols that are not held', () => {
    const backfill = sampleSummary({ symbol: 'NWND', reportDate: '2026-10-21', origin: 'backfill' });
    const stale = sampleSummary({ symbol: 'CLDV', reportDate: '2026-10-16' });
    const other = sampleSummary({ symbol: 'ZZZZ', reportDate: '2026-10-21' });
    const result = detectDueNotifications(base({ earnings: [backfill, stale, other] }));
    expect(result.due).toEqual([]);
    expect(result.silent).toEqual([
      { type: 'earnings', symbol: 'NWND', eventKey: '2026-10-21' },
      { type: 'earnings', symbol: 'CLDV', eventKey: '2026-10-16' },
    ]);
  });

  it('does nothing while the type is off', () => {
    const settings = { ...defaultNotificationSettings(), types: { ...defaultNotificationSettings().types, earnings: false } };
    expect(detectDueNotifications(base({ settings, earnings: [sampleSummary({ symbol: 'NWND' })] }))).toEqual({ due: [], silent: [] });
  });

  it('baselines every stored summary of a held symbol when the type is switched on', () => {
    const earnings = [sampleSummary({ symbol: 'NWND', reportDate: '2026-10-21' }), sampleSummary({ symbol: 'ZZZZ' })];
    expect(baselineEntries({ today: TODAY, transactions: [held('NWND')], dividendEvents: [], earnings, types: ['earnings'] })).toEqual([{ type: 'earnings', symbol: 'NWND', eventKey: '2026-10-21' }]);
    expect(baselineEntries({ today: TODAY, transactions: [held('NWND')], dividendEvents: [], earnings, types: ['received'] })).toEqual([]);
    expect(baselineEntries({ today: TODAY, transactions: [held('NWND')], dividendEvents: [], types: ['earnings'] })).toEqual([]);
  });

  it('stored settings from before earnings existed get it switched on', () => {
    expect(effectiveNotificationSettings({ types: { exDividend: false, declared: true, received: true }, exDividendDaysBefore: 3 })).toEqual({
      types: { exDividend: false, declared: true, received: true, earnings: true },
      exDividendDaysBefore: 3,
    });
    expect(effectiveNotificationSettings(null)).toEqual(defaultNotificationSettings());
    expect(effectiveNotificationSettings({ types: { earnings: false } }).types.earnings).toBe(false);
  });
});

describe('requests and the classification override', () => {
  it('validates the list query and the period', () => {
    expect(earningsListQuerySchema.parse({ symbol: ' lmt ', limit: '5' })).toEqual({ symbol: 'LMT', limit: 5 });
    expect(earningsListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(earningsListQuerySchema.safeParse({ limit: '25' }).success).toBe(false);
    expect(earningsPeriodSchema.safeParse('2026-10-21').success).toBe(true);
    expect(earningsPeriodSchema.safeParse('Q3').success).toBe(false);
  });

  it('accepts a KPI template on the classification override, alone or with other fields', () => {
    expect(classificationPutSchema.safeParse({ kpiTemplate: 'bank' })).toMatchObject({ success: true, data: { kpiTemplate: 'bank' } });
    expect(classificationPutSchema.safeParse({ kpiTemplate: 'tech' }).success).toBe(false);
    expect(hasClassification({ kpiTemplate: 'saas' })).toBe(true);
    expect(classificationFieldsOf({ kpiTemplate: 'reit', name: 'X', userId: 'ignored' } as never)).toEqual({ name: 'X', kpiTemplate: 'reit' });
  });
});

describe('the invented samples', () => {
  it('are fictional and complete enough for the demo', () => {
    const [bank, saas] = sampleDemoSummaries();
    expect(bank!.template).toBe('bank');
    expect(saas!.template).toBe('saas');
    expect(saas!.origin).toBe('backfill');
    expect(sampleSummary().headline.fcf?.basis).toBe('calculated');
    expect(sampleSummary({ symbol: 'X' }).symbol).toBe('X');
  });
});

describe('sampleDemoSummariesEpsOnly', () => {
  it('has the EPS estimate only (no range, no analysts, no revenue), the free-plan reason for revenue, and one company on another EPS basis', () => {
    const [bank, saas] = sampleDemoSummariesEpsOnly();
    expect(bank!.consensus).toMatchObject({ eps: { average: 4.9, epsOnly: true, source: 'consensus' }, revenueReason: 'free-plan' });
    expect(bank!.consensus?.eps).not.toHaveProperty('basisMismatch');
    expect(bank!.consensus?.eps).not.toHaveProperty('analysts');
    expect(bank!.consensus).not.toHaveProperty('revenue');
    expect(saas!.consensus?.eps).toMatchObject({ epsOnly: true, basisMismatch: true });
    expect(SAMPLE_EPS_ONLY_ENDPOINT.state).toBe('unavailable-on-key');
    expect(sampleDemoSummariesEpsOnly().map((s) => s.symbol)).toEqual(sampleDemoSummaries().map((s) => s.symbol));
  });
});

describe('sampleTemplateSummaries', () => {
  it('has one summary per template, with every second slot filled and valid keys', () => {
    const all = sampleTemplateSummaries();
    expect(all.map((s) => s.template)).toEqual([...KPI_TEMPLATE_IDS]);
    expect(new Set(all.map((s) => s.symbol)).size).toBe(all.length);
    const bank = all.find((s) => s.template === 'bank');
    expect(bank?.kpis.some((k) => k.metric !== undefined)).toBe(true);
    expect(bank?.kpis.some((k) => k.metric === undefined)).toBe(true);
  });
});

describe('the dividend and buyback of the samples', () => {
  it('has the schema version that carries the two blocks', () => {
    expect(EARNINGS_SCHEMA_VERSION).toBe(2);
    expect(sampleSummary().schemaVersion).toBe(EARNINGS_SCHEMA_VERSION);
  });

  it('shows a raise with repurchases in one demo company and N/A in the other', () => {
    const [bank, saas] = sampleDemoSummaries();
    expect(bank!.dividend).toMatchObject({ status: 'announced', action: 'raised', perShare: 1.25, previousPerShare: 1.2, payDate: '2026-11-27' });
    expect(bank!.buyback).toMatchObject({ status: 'announced', repurchased: 1_500_000_000, remaining: 4_500_000_000 });
    expect([saas!.dividend, saas!.buyback]).toEqual([{ status: 'none' }, { status: 'none' }]);
  });
});
