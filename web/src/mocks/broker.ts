import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  BROKER_ID,
  brokerScopeSchema,
  connectBrokerSchema,
  toBrokerStatus,
  type ApiError,
  type BrokerSyncState,
} from '@portfolio/shared';
import { API_BASE_URL } from '../config';
import * as db from './db';

/**
 * Demo/test simulation of the Trading 212 endpoints: nothing leaves the browser and no real credentials are involved.
 * A key named `invalid` is rejected like Trading 212 would; anything else connects. A sync takes one poll to finish.
 */
const PATH = `${API_BASE_URL}/brokers/trading212`;

interface MockBrokerState {
  state: BrokerSyncState | null;
  /** Polls left before a running sync finishes. */
  pendingPolls: number;
}

const initial = (): MockBrokerState => ({ state: null, pendingPolls: 0 });
let mock = initial();

export function resetBrokerMock(): void {
  mock = initial();
}

const failure = (status: number, code: string, message: string) =>
  HttpResponse.json<ApiError>({ error: { code, message } }, { status });

const nowIso = () => new Date().toISOString();

function finishSync(state: BrokerSyncState): BrokerSyncState {
  const at = nowIso();
  return {
    ...state,
    status: 'SUCCEEDED',
    accountCurrency: 'EUR',
    updatedAt: at,
    lastSyncAt: at,
    lastSuccessAt: at,
    counts: { orders: 42, dividends: 7, written: 49, skipped: 2, cashMovements: { deposits: 5, withdrawals: 1, fees: 0, interest: 12, other: 0 } },
    unmapped: [{ ticker: 'EXAMPLE_EQ', name: 'Example Corp', currency: 'EUR', reason: 'AMBIGUOUS_LISTING', count: 2 }],
    warnings: [],
  };
}

function statusOf(portfolioId: string): BrokerSyncState | null {
  const { state } = mock;
  if (state?.portfolioId !== portfolioId) return null;
  if (state.status === 'RUNNING' && mock.pendingPolls-- <= 0) mock.state = finishSync(state);
  return mock.state;
}

export const brokerHandlers: HttpHandler[] = [
  http.get(PATH, ({ request }) => {
    const scope = brokerScopeSchema.safeParse({ portfolioId: new URL(request.url).searchParams.get('portfolioId') });
    if (!scope.success) return failure(400, 'VALIDATION_ERROR', 'Invalid portfolioId');
    return HttpResponse.json(toBrokerStatus(scope.data.portfolioId, statusOf(scope.data.portfolioId)));
  }),

  http.put(PATH, async ({ request }) => {
    const parsed = connectBrokerSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return failure(400, 'VALIDATION_ERROR', 'Invalid Trading 212 connection request');
    const { portfolioId, apiKey, environment } = parsed.data;
    if (!db.listPortfolios().some((p) => p.portfolioId === portfolioId)) return failure(404, 'NOT_FOUND', `Portfolio ${portfolioId} not found`);
    if (mock.state && mock.state.portfolioId !== portfolioId) {
      return failure(409, 'BROKER_ALREADY_CONNECTED', 'Trading 212 is already connected to another portfolio; disconnect it first');
    }
    if (apiKey === 'invalid') {
      return failure(422, 'T212_AUTH_REJECTED', 'Trading 212 rejected the credentials. Check the key/secret and that the key has the read scopes.');
    }
    const at = nowIso();
    mock.state = {
      userId: 'demo',
      portfolioId,
      broker: BROKER_ID,
      environment,
      status: 'CONNECTED',
      accountCurrency: 'EUR',
      connectedAt: at,
      updatedAt: at,
    };
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete(PATH, () => {
    mock = initial();
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${PATH}/sync`, async ({ request }) => {
    const scope = brokerScopeSchema.safeParse(await request.json().catch(() => null));
    if (!scope.success) return failure(400, 'VALIDATION_ERROR', 'Invalid sync request');
    if (mock.state?.portfolioId !== scope.data.portfolioId) {
      return failure(404, 'NOT_CONNECTED', 'Trading 212 is not connected for this portfolio');
    }
    mock = { state: { ...mock.state, status: 'RUNNING', runStartedAt: nowIso() }, pendingPolls: 1 };
    return HttpResponse.json({ accepted: true }, { status: 202 });
  }),
];
