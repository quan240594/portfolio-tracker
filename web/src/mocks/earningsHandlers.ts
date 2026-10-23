/**
 * MSW handlers of the earnings summaries for the demo and the Playwright mock run. The two summaries are INVENTED (fictional companies, made-up
 * numbers): they exist so the page can be shown without the personal deployment behind it.
 */
import { http, HttpResponse, type HttpHandler } from 'msw';
import { sampleDemoSummaries, sampleTemplateSummaries, type EarningsListResponse, type EarningsStatusResponse } from '@portfolio/shared';
import { api, errorResponse, latency } from './utils';

/** The Playwright run sets this session flag to see one summary per KPI template instead of the two demo companies. */
const TEMPLATES_FLAG = 'earnings-demo-templates';
const summaries = () => (globalThis.sessionStorage?.getItem(TEMPLATES_FLAG) === 'on' ? sampleTemplateSummaries() : sampleDemoSummaries());

export const DEMO_EARNINGS_STATUS: EarningsStatusResponse = {
  available: true,
  configured: true,
  missing: [],
  estimatesConfigured: true,
  neurons: { used: 420, dailyCap: 6000, allowance: 10_000, state: 'ok', resetsAt: '2026-10-24T00:00:00.000Z' },
  symbols: summaries().map((summary) => ({ symbol: summary.symbol, eligible: true, lastCheckedAt: summary.generatedAt, lastResult: 'ok', latestReportDate: summary.reportDate })),
};

export const earningsHandlers: HttpHandler[] = [
  http.get(api('/earnings/status'), async () => {
    await latency();
    return HttpResponse.json(DEMO_EARNINGS_STATUS);
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
  http.post(api('/earnings/:symbol/refresh'), async () => {
    await latency();
    return HttpResponse.json({ accepted: true }, { status: 202 });
  }),
];
