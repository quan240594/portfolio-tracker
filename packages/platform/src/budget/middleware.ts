import type { ApiError } from '@portfolio/shared';
import type { PortableHandler, PortableRequest, PortableResponse } from '../http.js';
import type { BudgetDecision, BudgetGuard, WorkKind } from './guard.js';
import type { UsageDelta } from './usage-store.js';

/** Paths that keep working when the budget is exhausted, so the owner can sign in and see why (`/x/*` = `/x` and everything below). */
export const ALWAYS_ALLOWED_PATHS: readonly string[] = ['/health', '/usage', '/auth/*'];

/** What one request costs: it reaches the Worker and then the Durable Object. */
export const REQUEST_COST: UsageDelta = { workerRequests: 1, durableObjectRequests: 1 };

export interface WithBudgetOptions {
  /** Paths exempt from the refusal (they are still counted). Defaults to `ALWAYS_ALLOWED_PATHS`. */
  allowPaths?: readonly string[];
  /** Usage recorded for every request. Defaults to `REQUEST_COST`. */
  cost?: UsageDelta;
}

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export function workKindOf(request: Pick<PortableRequest, 'method'>): WorkKind {
  return READ_METHODS.has(request.method.toUpperCase()) ? 'read' : 'write';
}

/** Dot segments and encoded characters never match the allow-list, so `/auth/../tokens` cannot slip through. */
function isPlainPath(path: string): boolean {
  return path.startsWith('/') && !path.includes('%') && path.split('/').every((segment) => segment !== '.' && segment !== '..');
}

export function isAllowedPath(path: string, allowPaths: readonly string[]): boolean {
  if (!isPlainPath(path)) return false;
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return allowPaths.some((pattern) => {
    if (!pattern.endsWith('/*')) return normalized === pattern;
    const base = pattern.slice(0, -2);
    return normalized === base || normalized.startsWith(`${base}/`);
  });
}

function refusal(decision: BudgetDecision): PortableResponse {
  const unavailable = decision.state === 'unavailable';
  const body: ApiError = {
    error: unavailable
      ? { code: 'BUDGET_UNAVAILABLE', message: 'Usage limits cannot be checked right now, so only read requests are served.' }
      : {
          code: 'BUDGET_EXHAUSTED',
          message: 'The daily free-plan usage limit is nearly reached, so requests are paused until it resets.',
          details: { blockedMetrics: decision.blockedMetrics },
        },
  };
  return {
    status: unavailable ? 503 : 429,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(decision.retryAfterSeconds) },
    body: JSON.stringify(body),
  };
}

/**
 * Counts every request and refuses it before a free-plan cap is hit: 429 (`BUDGET_EXHAUSTED`, with `Retry-After` =
 * seconds until 00:00 UTC) when a metric is at 80 % of its cap, 503 (`BUDGET_UNAVAILABLE`) for a write while the usage
 * ledger cannot be read. Reads (GET/HEAD) still run in the second case. The allow-listed paths are never refused.
 */
export function withBudget(handler: PortableHandler, guard: BudgetGuard, options: WithBudgetOptions = {}): PortableHandler {
  const allowPaths = options.allowPaths ?? ALWAYS_ALLOWED_PATHS;
  const cost = options.cost ?? REQUEST_COST;
  return async (request) => {
    await guard.record(cost);
    if (isAllowedPath(request.path, allowPaths)) return handler(request);
    const decision = await guard.check(workKindOf(request));
    return decision.allowed ? handler(request) : refusal(decision);
  };
}
