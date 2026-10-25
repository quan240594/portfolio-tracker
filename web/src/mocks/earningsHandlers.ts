/**
 * MSW handlers of the earnings summaries for the demo and the Playwright mock run. The two summaries are INVENTED (fictional companies, made-up
 * numbers): they exist so the page can be shown without the personal deployment behind it.
 */
import { http, HttpResponse, type HttpHandler } from 'msw';
import { sampleDemoSummaries, sampleTemplateSummaries, type EarningsListResponse, type EarningsStatusResponse } from '@portfolio/shared';
import { api, errorResponse, latency } from './utils';

/** The Playwright run sets this session flag to see one summary per KPI template instead of the two demo companies. */
const TEMPLATES_FLAG = 'earnings-demo-templates';
/** ... and this one to see a deployment where nothing was stored yet and every company says why (invented companies). */
const EMPTY_FLAG = 'earnings-demo-empty';
const flagged = (flag: string): boolean => globalThis.sessionStorage?.getItem(flag) === 'on';
const summaries = () => {
  if (flagged(EMPTY_FLAG)) return [];
  return flagged(TEMPLATES_FLAG) ? sampleTemplateSummaries() : sampleDemoSummaries();
};

const AT = '2026-10-25T06:30:00.000Z';

/** One line of each kind for the page that has nothing to show: the AI could not read a release, no release, no SEC registration, a fund. */
const EMPTY_SYMBOLS: EarningsStatusResponse['symbols'] = [
  { symbol: 'CLDV', eligible: true, lastCheckedAt: AT, lastRun: { at: AT, stage: 'ai', detail: 'invalid JSON', filing: { form: '8-K', date: '2026-10-21', accession: '0001000404-26-000003' } }, releases: { planned: 4, stored: 0, failed: 1 } },
  { symbol: 'HBRB', eligible: true, lastCheckedAt: AT, lastRun: { at: AT, stage: 'no-release-found', detail: 'no results release in the last 135 days' } },
  { symbol: 'NRDV.AS', eligible: true, lastCheckedAt: AT, lastRun: { at: AT, stage: 'ticker-map', detail: 'not found in the SEC company list (no US registration, or the name matches none)' } },
  { symbol: 'VWRL', eligible: false },
];

function demoStatus(): EarningsStatusResponse {
  const shown = summaries();
  if (shown.length === 0) {
    return {
      available: true,
      configured: true,
      missing: [],
      estimatesConfigured: true,
      neurons: { used: 5980, dailyCap: 6000, allowance: 10_000, state: 'warn', resetsAt: '2026-10-26T00:00:00.000Z' },
      backfill: { status: 'running', quarters: 4, total: 12, done: 3, stored: 2, failed: 1, planned: 3, companies: 3, waitReason: 'allowance', waitUntil: '2026-10-26T00:05:00.000Z' },
      lastFullPassAt: AT,
      symbols: EMPTY_SYMBOLS,
    };
  }
  return {
    available: true,
    configured: true,
    missing: [],
    estimatesConfigured: true,
    neurons: { used: 420, dailyCap: 6000, allowance: 10_000, state: 'ok', resetsAt: '2026-10-24T00:00:00.000Z' },
    backfill: { status: 'complete', quarters: 4, total: 8, done: 8, stored: 8, failed: 0, planned: 2, companies: 2, completedAt: '2026-10-24T08:00:00.000Z' },
    lastFullPassAt: '2026-10-24T08:00:00.000Z',
    symbols: shown.map((summary) => ({
      symbol: summary.symbol,
      eligible: true,
      lastCheckedAt: summary.generatedAt,
      lastResult: 'ok',
      latestReportDate: summary.reportDate,
      lastRun: { at: summary.generatedAt, stage: 'ok', detail: 'summary stored', filing: { form: summary.form, date: summary.reportDate, accession: summary.accession } },
      releases: { planned: 4, stored: 4, failed: 0 },
    })),
  };
}

export const DEMO_EARNINGS_STATUS: EarningsStatusResponse = demoStatus();

export const earningsHandlers: HttpHandler[] = [
  http.get(api('/earnings/status'), async () => {
    await latency();
    return HttpResponse.json(demoStatus());
  }),
  http.get(api('/earnings'), async ({ request }) => {
    await latency();
    const url = new URL(request.url);
    const symbol = url.searchParams.get('symbol')?.toUpperCase();
    const limit = Number(url.searchParams.get('limit') ?? '12');
    const all = summaries();
    const picked = (symbol === undefined ? all : all.filter((summary) => summary.symbol === symbol)).toSorted((a, b) => b.reportDate.localeCompare(a.reportDate)).slice(0, limit);
    return HttpResponse.json<EarningsListResponse>({ available: true, summaries: picked, symbols: all.map((summary) => summary.symbol).toSorted((a, b) => a.localeCompare(b)) });
  }),
  http.get(api('/earnings/:symbol/:period'), async ({ params }) => {
    await latency();
    const found = summaries().find((summary) => summary.symbol === String(params.symbol).toUpperCase() && summary.reportDate === params.period);
    return found ? HttpResponse.json(found) : errorResponse(404, 'NOT_FOUND', 'No earnings summary for this symbol and period');
  }),
  http.post(api('/earnings/backfill'), async () => {
    await latency();
    return HttpResponse.json({ accepted: true }, { status: 202 });
  }),
  http.post(api('/earnings/:symbol/refresh'), async () => {
    await latency();
    return HttpResponse.json({ accepted: true }, { status: 202 });
  }),
];
