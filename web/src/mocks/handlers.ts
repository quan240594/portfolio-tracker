import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  ALLOCATION_DIMENSIONS,
  createImportSchema,
  createPortfolioSchema,
  historyQuerySchema,
  portfolioScopeSchema,
  updatePortfolioSchema,
  transactionInputSchema,
  type CreateImportResponse,
  type ListPortfoliosResponse,
  type ListTransactionsResponse,
} from '@portfolio/shared';
import { brokerHandlers } from './broker';
import * as db from './db';
import { analyticsHandlers } from './analyticsHandlers';
import { securitiesHandlers } from './securitiesHandlers';
import { dividendsOverviewHandlers } from './dividendsOverviewHandlers';
import { growthHandlers } from './growthHandlers';
import { goalsHandlers } from './goals-handlers';
import { inflationHandlers } from './inflationHandlers';
import { classificationHandlers } from './classification-handlers';
import { calendarHandlers } from './calendarHandlers';
import { logoHandlers } from './logo-handlers';
import { earningsHandlers } from './earningsHandlers';
import { layoutHandlers } from './layoutHandlers';
import { categoryAllocation, managementHandlers } from './management-handlers';
import { api, errorResponse, guard, latency } from './utils';

const origin = () => globalThis.location?.origin ?? 'http://localhost';
export const MOCK_UPLOAD_PATH = '/__mock-s3/imports/:importId';

/** Parses `?portfolioId=` (omitted/`all` = combined); throws a 400 for malformed ids. */
function scopeOf(request: Request): string | undefined {
  const raw = new URL(request.url).searchParams.get('portfolioId') ?? undefined;
  const parsed = portfolioScopeSchema.safeParse({ portfolioId: raw });
  if (!parsed.success) throw new db.MockHttpError(400, 'VALIDATION_ERROR', 'Invalid portfolio id', parsed.error.flatten());
  return parsed.data.portfolioId;
}

export const handlers: HttpHandler[] = [
  ...analyticsHandlers,
  ...dividendsOverviewHandlers,
  ...growthHandlers,
  ...calendarHandlers,
  ...earningsHandlers,
  ...layoutHandlers,
  http.get(api('/health'), () => HttpResponse.json({ status: 'ok' })),

  http.get(api('/portfolios'), async () => {
    await latency();
    return HttpResponse.json<ListPortfoliosResponse>({ portfolios: db.listPortfolios() });
  }),

  http.post(api('/portfolios'), async ({ request }) => {
    await latency();
    const parsed = createPortfolioSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid portfolio', parsed.error.flatten());
    }
    return guard(() => HttpResponse.json(db.createPortfolio(parsed.data.name), { status: 201 }))();
  }),

  http.patch(api('/portfolios/:id'), async ({ request, params }) => {
    await latency();
    const parsed = updatePortfolioSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid portfolio', parsed.error.flatten());
    }
    return guard(() => HttpResponse.json(db.renamePortfolio(String(params.id), parsed.data.name)))();
  }),

  http.delete(api('/portfolios/:id'), async ({ request, params }) => {
    await latency();
    const force = new URL(request.url).searchParams.get('force') === 'true';
    return guard(() => {
      db.deletePortfolio(String(params.id), force);
      return new HttpResponse(null, { status: 204 });
    })();
  }),

  http.get(api('/portfolio'), async ({ request }) => {
    await latency();
    return guard(() => HttpResponse.json(db.getPortfolio(scopeOf(request))))();
  }),

  http.get(api('/holdings'), async ({ request }) => {
    await latency();
    return guard(() => HttpResponse.json(db.getHoldings(scopeOf(request))))();
  }),

  http.get(api('/allocation'), async ({ request }) => {
    await latency();
    const by = new URL(request.url).searchParams.get('by') ?? 'assetClass';
    if (by === 'category') return guard(() => HttpResponse.json(categoryAllocation(scopeOf(request))))();
    if (!(ALLOCATION_DIMENSIONS as readonly string[]).includes(by)) {
      return errorResponse(400, 'VALIDATION_ERROR', `Invalid allocation dimension: ${by}`);
    }
    return guard(() => HttpResponse.json(db.getAllocation(by as (typeof ALLOCATION_DIMENSIONS)[number], scopeOf(request))))();
  }),

  http.get(api('/history'), async ({ request }) => {
    await latency();
    const parsed = historyQuerySchema.safeParse({ range: new URL(request.url).searchParams.get('range') ?? undefined });
    if (!parsed.success) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid range', parsed.error.flatten());
    return guard(() => HttpResponse.json(db.getHistory(parsed.data.range, scopeOf(request))))();
  }),

  http.get(api('/dividends'), async ({ request }) => {
    await latency();
    return guard(() => HttpResponse.json(db.getDividends(scopeOf(request))))();
  }),

  http.get(api('/transactions'), async ({ request }) => {
    await latency();
    return guard(() => HttpResponse.json<ListTransactionsResponse>({ transactions: db.listTransactions(scopeOf(request)) }))();
  }),

  http.post(api('/transactions'), async ({ request }) => {
    await latency();
    const parsed = transactionInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid transaction', parsed.error.flatten());
    return guard(() => HttpResponse.json(db.addTransaction(parsed.data), { status: 201 }))();
  }),

  http.delete(api('/transactions/:id'), async ({ params }) => {
    await latency();
    return guard(() => {
      db.deleteTransaction(String(params.id));
      return new HttpResponse(null, { status: 204 });
    })();
  }),

  http.post(api('/imports'), async ({ request }) => {
    await latency();
    const parsed = createImportSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid import', parsed.error.flatten());
    }
    return guard(() => {
      const imp = db.createImport(parsed.data.fileName, parsed.data.portfolioId);
      return HttpResponse.json<CreateImportResponse>(
        { importId: imp.importId, uploadUrl: `${origin()}${MOCK_UPLOAD_PATH.replace(':importId', imp.importId)}?X-Mock-Signature=demo`, expiresInSeconds: 300 },
        { status: 201 },
      );
    })();
  }),

  http.get(api('/imports/:id'), async ({ params }) => {
    await latency();
    return guard(() => HttpResponse.json(db.getImport(String(params.id))))();
  }),

  http.put(`*${MOCK_UPLOAD_PATH}`, async ({ request, params }) => {
    await latency();
    if (request.headers.get('content-type') !== 'text/csv') {
      return new HttpResponse('Content-Type must be text/csv', { status: 403 });
    }
    const csv = await request.text();
    return guard(() => {
      db.storeUpload(String(params.importId), csv);
      return new HttpResponse(null, { status: 200 });
    })();
  }),

  ...managementHandlers,
  ...goalsHandlers,
  ...inflationHandlers,
  ...classificationHandlers,
  ...logoHandlers,
  ...securitiesHandlers,
  ...brokerHandlers,
];
