import { logger, type PortableHandler } from '@portfolio/platform';
import { MissingFxRateError, PortfolioError } from '@portfolio/shared';
import { errorBody, HttpError, toResponse, type RouteResult } from './lib/http.js';
import { resolveUserId } from './lib/auth.js';
import { matchRoute } from './router.js';
import type { Deps } from './deps.js';

export function errorToResult(err: unknown): RouteResult {
  if (err instanceof HttpError) {
    return { statusCode: err.statusCode, body: errorBody(err.code, err.message, err.details) };
  }
  if (err instanceof MissingFxRateError) {
    return { statusCode: 503, body: errorBody('FX_UNAVAILABLE', err.message) };
  }
  if (err instanceof PortfolioError) {
    return { statusCode: 422, body: errorBody('UNPROCESSABLE', err.message) };
  }
  return { statusCode: 500, body: errorBody('INTERNAL_ERROR', 'Internal server error') };
}

/**
 * The whole API as one platform-neutral function: a `PortableRequest` in, a `PortableResponse` out. Adapters translate
 * their native request (API Gateway event, Node request, Worker `Request`) to and from these types and nothing else.
 * `getDeps` is called per request, so an adapter can build its clients lazily and reuse them.
 */
export function createApp(getDeps: () => Deps): PortableHandler {
  return async (request) => {
    const started = Date.now();
    const { method } = request;
    if (request.requestId) logger.appendKeys({ requestId: request.requestId });
    const deps = getDeps();
    let route = `${method} ${request.path}`;
    let result: RouteResult;
    try {
      if (method === 'OPTIONS') {
        result = { statusCode: 204, body: undefined };
      } else {
        // Authenticate before routing so unauthenticated callers learn nothing about which routes exist.
        const userId = resolveUserId(request, deps.config);
        const matched = matchRoute(method, request.path);
        route = matched.route;
        result = await matched.handler({ deps, userId, pathParams: matched.pathParams, query: request.query, body: request.body });
      }
    } catch (err) {
      result = errorToResult(err);
      if (result.statusCode >= 500) logger.error('Request failed', { route, error: err as Error });
      else logger.warn('Request rejected', { route, statusCode: result.statusCode, reason: (err as Error).message });
    }
    logger.info('Request completed', { route, method, statusCode: result.statusCode, latencyMs: Date.now() - started });
    logger.removeKeys(['requestId']);
    return toResponse(result, deps.config.corsAllowedOrigin);
  };
}
