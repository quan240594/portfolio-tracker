import type { ALPHAVANTAGE_PROBE_ROUTES, AlphaVantageProbeStatus } from '@portfolio/shared';
import { HttpError, ok, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import type { RouteHandler } from '../router.js';

const NOT_AVAILABLE = 'This deployment has no Alpha Vantage test (it is part of the Cloudflare app).';

/** `GET /diagnostics/alphavantage-probe`: whether the test may run now, when it may next, the day's allowance and the last result. Reads only. */
export async function getAlphaVantageProbe(ctx: RouteContext): Promise<RouteResult> {
  const { alphaVantageProbe } = ctx.deps;
  const status: AlphaVantageProbeStatus = alphaVantageProbe ? await alphaVantageProbe.status() : { available: false, reason: NOT_AVAILABLE, nextAllowedAt: null, budget: null, last: null };
  return ok(status);
}

/**
 * `POST /diagnostics/alphavantage-probe`: one real `EARNINGS_ESTIMATES` call for a fixed ticker and an `EARNINGS` control call, and what Alpha Vantage said to each
 * with the conclusion. 404 where the deployment has no such test, 503 without a key, 429 when it ran less than 10 minutes ago or fewer than 4 of the day's calls are left.
 */
export async function runAlphaVantageProbe(ctx: RouteContext): Promise<RouteResult> {
  const { alphaVantageProbe } = ctx.deps;
  if (!alphaVantageProbe) throw new HttpError(404, 'NOT_AVAILABLE', NOT_AVAILABLE);
  const outcome = await alphaVantageProbe.run();
  if (outcome.accepted) return ok(outcome.result);
  if (outcome.reason === 'not-configured') throw new HttpError(503, 'NOT_CONFIGURED', outcome.message);
  const retryAfter = outcome.retryAfterSeconds;
  return {
    statusCode: 429,
    body: { error: { code: 'RATE_LIMITED', message: outcome.message, details: { reason: outcome.reason, retryAfterSeconds: retryAfter } } },
    ...(retryAfter === undefined ? {} : { headers: { 'retry-after': String(retryAfter) } }),
  };
}

export const alphaVantageProbeHandlers: Record<keyof typeof ALPHAVANTAGE_PROBE_ROUTES, RouteHandler> = {
  alphaVantageProbeStatus: getAlphaVantageProbe,
  alphaVantageProbe: runAlphaVantageProbe,
};
