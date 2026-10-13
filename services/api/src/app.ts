import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { MissingFxRateError, PortfolioError } from '@portfolio/shared';
import { errorBody, HttpError, toResponse, type RouteResult } from './lib/http.js';
import { logger } from './lib/logger.js';
import { matchRoute } from './router.js';
import type { Deps } from './deps.js';

type JwtAuthorizer = { jwt?: { claims?: Record<string, unknown> } };

export function resolveUserId(event: APIGatewayProxyEventV2, demoUserId: string): string {
  const authorizer = (event.requestContext as { authorizer?: JwtAuthorizer }).authorizer;
  const sub = authorizer?.jwt?.claims?.sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : demoUserId;
}

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

export type ApiHandler = (
  event: APIGatewayProxyEventV2,
  context?: Partial<Context>,
) => Promise<APIGatewayProxyStructuredResultV2>;

export function createHandler(getDeps: () => Deps): ApiHandler {
  return async (event, context) => {
    const started = Date.now();
    const method = event.requestContext.http.method.toUpperCase();
    const requestId = context?.awsRequestId ?? event.requestContext.requestId;
    logger.appendKeys({ requestId });
    const deps = getDeps();
    let route = `${method} ${event.rawPath}`;
    let result: RouteResult;
    try {
      if (method === 'OPTIONS') {
        result = { statusCode: 204, body: undefined };
      } else {
        const matched = matchRoute(method, event.rawPath);
        route = matched.route;
        result = await matched.handler({
          deps,
          userId: resolveUserId(event, deps.config.demoUserId),
          pathParams: matched.pathParams,
          query: event.queryStringParameters ?? {},
          body: event.body,
          isBase64Encoded: event.isBase64Encoded,
        });
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
