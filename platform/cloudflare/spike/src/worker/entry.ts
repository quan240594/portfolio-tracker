/**
 * Workers entry of the spike: the UNMODIFIED route handlers of services/api (router + routes + shared engine) on top of
 * ItemsRepository + D1ItemStore. Single user, no auth (a stub for the offline spike only).
 */
import { MissingFxRateError, PortfolioError } from '../../../../../packages/shared/src/index.js';
import { HttpError, errorBody, type RouteResult } from '../../../../../services/api/src/lib/http.js';
import { matchRoute } from '../../../../../services/api/src/router.js';
import type { Deps } from '../../../../../services/api/src/deps.js';
import { ItemsRepository, PACKED_LAYOUT } from '../store/items-repository.ts';
import { D1ItemStore, type D1Like } from './d1-store.ts';

interface Env {
  DB: D1Like;
}

const toResult = (err: unknown): RouteResult => {
  if (err instanceof HttpError) return { statusCode: err.statusCode, body: errorBody(err.code, err.message, err.details) };
  if (err instanceof MissingFxRateError) return { statusCode: 503, body: errorBody('FX_UNAVAILABLE', err.message) };
  if (err instanceof PortfolioError) return { statusCode: 422, body: errorBody('UNPROCESSABLE', err.message) };
  console.error('internal error', err);
  return { statusCode: 500, body: errorBody('INTERNAL_ERROR', 'Internal server error') };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const store = new D1ItemStore(env.DB);
    const repo = new ItemsRepository(store, PACKED_LAYOUT);
    let n = 0;
    const deps: Deps = {
      repo,
      mgmt: repo,
      events: { transactionsChanged: () => Promise.resolve() },
      signer: { signCsvUpload: () => Promise.resolve('') },
      config: { baseCurrency: 'EUR', authMode: 'demo', demoUserId: 'demo', corsAllowedOrigin: '*' },
      now: () => new Date(url.searchParams.get('now') ?? Date.now()),
      uuid: () => crypto.randomUUID() + String(n++),
    };
    let result: RouteResult;
    try {
      const matched = matchRoute(request.method, url.pathname);
      const text = request.method === 'GET' ? '' : await request.text();
      result = await matched.handler({
        deps,
        userId: 'demo',
        pathParams: matched.pathParams,
        query: Object.fromEntries(url.searchParams),
        body: text || undefined,
        isBase64Encoded: false,
      });
    } catch (err) {
      result = toResult(err);
    }
    const body = result.body === undefined ? '' : result.contentType && typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    return new Response(body, {
      status: result.statusCode,
      headers: {
        'content-type': result.contentType ?? 'application/json',
        'x-d1-queries': String(store.stats.queries),
        'x-rows-read': String(store.stats.rowsRead),
        'x-d1-meta-rows-read': String(store.meta.rowsRead),
        'x-d1-meta-rows-written': String(store.meta.rowsWritten),
      },
    });
  },
};
