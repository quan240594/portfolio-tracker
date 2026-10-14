import {
  BROKER_ID,
  brokerScopeSchema,
  connectBrokerSchema,
  toBrokerStatus,
  type BrokerSyncState,
  type SyncBrokerResponse,
} from '@portfolio/shared';
import { BrokerError, type BrokerErrorCode } from '@portfolio/broker-sync';
import type { BrokerDeps } from '../broker-deps.js';
import type { RouteContext } from '../deps.js';
import { HttpError, ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import { requirePortfolio } from './portfolios.js';

/** Credential failures are 422, not 401: the user's own session is fine, only the Trading 212 key is not. */
const BROKER_ERROR_STATUS: Record<BrokerErrorCode, number> = {
  T212_AUTH_REJECTED: 422,
  T212_RATE_LIMITED: 429,
  T212_HTTP_ERROR: 502,
  T212_NETWORK: 502,
  T212_BAD_RESPONSE: 502,
  NO_CREDENTIALS: 422,
  VALIDATION_FAILED: 422,
};

function requireBroker(ctx: RouteContext): BrokerDeps {
  if (!ctx.deps.broker) throw new HttpError(503, 'BROKER_UNAVAILABLE', 'The Trading 212 sync is not configured');
  return ctx.deps.broker;
}

async function requireConnected(broker: BrokerDeps, ctx: RouteContext, portfolioId: string): Promise<BrokerSyncState> {
  const state = await broker.store.getState(ctx.userId, portfolioId);
  if (!state) throw new HttpError(404, 'NOT_CONNECTED', 'Trading 212 is not connected for this portfolio');
  return state;
}

export async function brokerStatus(ctx: RouteContext): Promise<RouteResult> {
  const { portfolioId } = validate(brokerScopeSchema.safeParse(ctx.query), 'Invalid portfolioId');
  const broker = requireBroker(ctx);
  return ok(toBrokerStatus(portfolioId, await broker.store.getState(ctx.userId, portfolioId)));
}

/** PUT: verifies the key against Trading 212, stores it (Secrets Manager, keyed by the caller) and records the connection. */
export async function connectBroker(ctx: RouteContext): Promise<RouteResult> {
  const { portfolioId, ...credentials } = validate(
    connectBrokerSchema.safeParse(parseJsonBody(ctx.body, ctx.isBase64Encoded)),
    'Invalid Trading 212 connection request',
  );
  const broker = requireBroker(ctx);
  await requirePortfolio(ctx, portfolioId);

  // One credential set per user: a second portfolio would import the same account twice.
  const states = await broker.store.listStates(ctx.userId);
  if (states.some((s) => s.portfolioId !== portfolioId)) {
    throw new HttpError(409, 'BROKER_ALREADY_CONNECTED', 'Trading 212 is already connected to another portfolio; disconnect it first');
  }

  const { accountCurrency } = await broker.verify(credentials).catch((err: unknown) => {
    if (err instanceof BrokerError) throw new HttpError(BROKER_ERROR_STATUS[err.code], err.code, err.message);
    throw err;
  });
  await broker.credentials.put(ctx.userId, credentials);

  const ts = ctx.deps.now().toISOString();
  const existing = states[0];
  const { lastError: _cleared, ...kept } = existing ?? {};
  const state: BrokerSyncState = {
    connectedAt: ts,
    ...kept,
    userId: ctx.userId,
    portfolioId,
    broker: BROKER_ID,
    environment: credentials.environment,
    status: existing && existing.status !== 'FAILED' ? existing.status : 'CONNECTED',
    accountCurrency,
    updatedAt: ts,
  };
  await (existing ? broker.store.saveState(state) : broker.store.createState(state));
  return ok(undefined, 204);
}

/** DELETE: removes the secret and the connection state. Transactions that were already imported are kept. */
export async function disconnectBroker(ctx: RouteContext): Promise<RouteResult> {
  const broker = requireBroker(ctx);
  await broker.credentials.delete(ctx.userId);
  await broker.store.deleteStates(ctx.userId);
  return ok(undefined, 204);
}

/** POST: starts an asynchronous sync of one connected portfolio. */
export async function syncBroker(ctx: RouteContext): Promise<RouteResult> {
  const { portfolioId } = validate(
    brokerScopeSchema.safeParse(parseJsonBody(ctx.body, ctx.isBase64Encoded)),
    'Invalid sync request',
  );
  const broker = requireBroker(ctx);
  await requireConnected(broker, ctx, portfolioId);
  await broker.invokeSync({ userId: ctx.userId, portfolioId });
  return ok({ accepted: true } satisfies SyncBrokerResponse, 202);
}
