import { delay, http, HttpResponse, type HttpHandler } from 'msw';
import {
  ALLOCATION_DIMENSIONS,
  createImportSchema,
  historyQuerySchema,
  transactionInputSchema,
  type ApiError,
  type CreateImportResponse,
  type ListTransactionsResponse,
} from '@portfolio/shared';
import { API_BASE_URL } from '../config';
import * as db from './db';

/** Resolve handler URLs the same way the client does (relative to the page origin). */
const origin = () => globalThis.location?.origin ?? 'http://localhost';
const api = (path: string) => `${API_BASE_URL}${path}`;
export const MOCK_UPLOAD_PATH = '/__mock-s3/imports/:importId';

const errorResponse = (status: number, code: string, message: string, details?: unknown): Response =>
  HttpResponse.json<ApiError>({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status });

async function latency() {
  if (import.meta.env.MODE !== 'test') await delay(150 + (crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32) * 250);
}

function guard<T>(fn: () => T | Promise<T>) {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof db.MockHttpError) return errorResponse(err.status, err.code, err.message, err.details);
      throw err;
    }
  };
}

export const handlers: HttpHandler[] = [
  http.get(api('/health'), () => HttpResponse.json({ status: 'ok' })),

  http.get(api('/portfolio'), async () => {
    await latency();
    return HttpResponse.json(db.getPortfolio());
  }),

  http.get(api('/holdings'), async () => {
    await latency();
    return HttpResponse.json(db.getHoldings());
  }),

  http.get(api('/allocation'), async ({ request }) => {
    await latency();
    const by = new URL(request.url).searchParams.get('by') ?? 'assetClass';
    if (!(ALLOCATION_DIMENSIONS as readonly string[]).includes(by)) {
      return errorResponse(400, 'VALIDATION_ERROR', `Invalid allocation dimension: ${by}`);
    }
    return HttpResponse.json(db.getAllocation(by as (typeof ALLOCATION_DIMENSIONS)[number]));
  }),

  http.get(api('/history'), async ({ request }) => {
    await latency();
    const parsed = historyQuerySchema.safeParse({ range: new URL(request.url).searchParams.get('range') ?? undefined });
    if (!parsed.success) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid range', parsed.error.flatten());
    return HttpResponse.json(db.getHistory(parsed.data.range));
  }),

  http.get(api('/dividends'), async () => {
    await latency();
    return HttpResponse.json(db.getDividends());
  }),

  http.get(api('/transactions'), async () => {
    await latency();
    return HttpResponse.json<ListTransactionsResponse>({ transactions: db.listTransactions() });
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
    const imp = db.createImport(parsed.data.fileName);
    return HttpResponse.json<CreateImportResponse>(
      { importId: imp.importId, uploadUrl: `${origin()}${MOCK_UPLOAD_PATH.replace(':importId', imp.importId)}?X-Mock-Signature=demo`, expiresInSeconds: 300 },
      { status: 201 },
    );
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
];
