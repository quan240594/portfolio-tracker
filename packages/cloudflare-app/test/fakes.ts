/**
 * Network fakes of the tests (no real network, no real accounts): GitHub's OAuth endpoints and the Trading 212 REST API.
 * They are plain functions from a minimal request to a plain reply, so the same fakes serve the Node tests (injected
 * `fetch`) and the workerd tests (Miniflare's `outboundService`), each side turning the reply into its own `Response`.
 */
export interface FakeRequest {
  url: string;
  method: string;
  header(name: string): string | null;
}

export interface FakeReply {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

export type FakeService = (request: FakeRequest) => FakeReply | undefined;

/** Test values only: none of these is a real id, secret or token. */
export const OWNER_ID = 424242;
export const OWNER_LOGIN = 'the-owner';
export const OTHER_ID = 777;
export const ORIGIN = 'https://app.example.test';
export const TEST_SESSION_SECRET = 'test-session-secret-0123456789-abcdef';
export const TEST_CLIENT_SECRET = 'test-client-secret-value';
export const TEST_CLIENT_ID = 'test-client-id';
/** Base64 of 32 bytes of 0x07. */
export const TEST_SECRETS_KEY = btoa(String.fromCodePoint(...new Array<number>(32).fill(7)));

export const T212_KEY = 'test-t212-key-id';
export const T212_SECRET = 'test-t212-secret-value';

/** GitHub OAuth: the token exchange and `GET /user`. `signedInAs` is the account the next sign-in resolves to. */
export class FakeGithub {
  signedInAs: { id: number; login: string } = { id: OWNER_ID, login: OWNER_LOGIN };
  readonly calls: string[] = [];

  readonly service: FakeService = (request) => {
    const { host, pathname } = new URL(request.url);
    if (host === 'github.com' && pathname === '/login/oauth/access_token') {
      this.calls.push('token');
      return { status: 200, json: { access_token: 'fake-access-token', token_type: 'bearer', scope: '' } };
    }
    if (host === 'api.github.com' && pathname === '/user') {
      this.calls.push('user');
      return { status: 200, json: this.signedInAs };
    }
    return undefined;
  };
}

const T212_PREFIX = '/api/v0/equity/';
/** Last prices Trading 212 reports for the open positions of the tests. */
export const SAP_PRICE = 231.4;
export const AAPL_T212_PRICE = 212.5;

/** Trading 212: one account in EUR with two history pages holding one buy of 3 shares of SAP and one of 2. */
export class FakeTrading212 {
  /** `METHOD path` of every call, in order. Credentials never appear here. */
  readonly calls: string[] = [];
  /** The `authorization` header of the last call was the Basic credentials of the test key (compared, never stored). */
  authorized = false;
  rejectCredentials = false;
  /** Replaces the answer of `GET positions` (a failure such as 429 or 500); the credential check still comes first. */
  positionsReply: FakeReply | undefined;
  /** The open positions: 5 shares of SAP (the 2 buys of the history) and 2 of AAPL (a manual transaction in the tests). Prices are in the instrument currency. */
  positions: unknown[] = [
    { instrument: { ticker: 'SAPd_EQ', isin: 'DE0007164600', name: 'SAP', currency: 'EUR' }, quantity: 5, currentPrice: SAP_PRICE, averagePricePaid: 200, walletImpact: { currency: 'EUR', totalCost: 1000, currentValue: 5 * SAP_PRICE } },
    { instrument: { ticker: 'AAPL_US_EQ', isin: 'US0378331005', name: 'Apple', currency: 'USD' }, quantity: 2, currentPrice: AAPL_T212_PRICE, averagePricePaid: 200 },
  ];

  /** How many times `GET positions` was called. */
  positionCalls(): number {
    return this.calls.filter((entry) => entry === 'GET positions').length;
  }

  readonly service: FakeService = (request) => {
    const url = new URL(request.url);
    if (!url.host.endsWith('.trading212.com') || !url.pathname.startsWith(T212_PREFIX)) return undefined;
    const path = url.pathname.slice(T212_PREFIX.length);
    this.calls.push(`${request.method} ${path}`);
    this.authorized = request.header('authorization') === `Basic ${btoa(`${T212_KEY}:${T212_SECRET}`)}`;
    if (this.rejectCredentials || !this.authorized) return { status: 401, json: { message: 'unauthorized' } };
    if (path === 'positions' && this.positionsReply) return this.positionsReply;
    return { status: 200, json: this.body(path, url.searchParams) };
  };

  private body(path: string, query: URLSearchParams): unknown {
    switch (path) {
      case 'account/summary':
        return { id: 1, currency: 'EUR' };
      case 'history/orders':
        return query.has('cursor') ? { items: [order('2', 2, '2026-01-03T10:00:00Z')] } : { items: [order('1', 3, '2026-01-02T10:00:00Z')], nextPagePath: `${T212_PREFIX}history/orders?limit=50&cursor=2` };
      case 'history/dividends':
      case 'history/transactions':
        return { items: [] };
      case 'positions':
        return this.positions;
      default:
        return [];
    }
  }
}

function order(id: string, quantity: number, filledAt: string) {
  return {
    order: { id, side: 'BUY', status: 'FILLED', ticker: 'SAPd_EQ', instrument: { ticker: 'SAPd_EQ', isin: 'DE0007164600', name: 'SAP', currency: 'EUR' } },
    fill: { id: `fill-${id}`, price: 200, quantity, filledAt, type: 'TRADE', walletImpact: { currency: 'EUR', netValue: quantity * 200, taxes: [] } },
  };
}

/** The first service that answers; an unexpected outbound call is a failing test, never a real request. */
export function route(services: readonly FakeService[], request: FakeRequest): FakeReply {
  for (const service of services) {
    const reply = service(request);
    if (reply) return reply;
  }
  throw new Error(`Unexpected outbound request to ${new URL(request.url).host}`);
}

export const TD_KEY = 'test-twelvedata-key';
export const AV_KEY = 'test-alphavantage-key';
export const AAPL_CLOSE = 230.12;

/**
 * The market-data sources the price jobs call: Twelve Data (quote, daily history), Alpha Vantage (company overview) and the
 * keyless Frankfurter ECB API. `clock` is the Hub's clock, so the quotes are always "just now" and never stale.
 */
export class FakePrices {
  /** `host path` of every call, in order. */
  readonly calls: string[] = [];

  constructor(private readonly clock: () => number) {}

  readonly service: FakeService = (request) => {
    const url = new URL(request.url);
    const handler = this.handlers[url.host];
    if (!handler) return undefined;
    this.calls.push(`${url.host} ${url.pathname}`);
    return handler(url, request);
  };

  callsTo(host: string): string[] {
    return this.calls.filter((call) => call.startsWith(`${host} `));
  }

  private readonly handlers: Record<string, (url: URL, request: FakeRequest) => FakeReply> = {
    'api.twelvedata.com': (url, request) => {
      if (request.header('authorization') !== `apikey ${TD_KEY}`) return { status: 401, json: { code: 401, status: 'error', message: 'bad key' } };
      switch (url.pathname) {
        case '/quote':
          return { status: 200, json: { symbol: 'AAPL', currency: 'USD', close: String(AAPL_CLOSE), previous_close: '228.5', timestamp: Math.floor(this.clock() / 1000) } };
        case '/time_series':
          return { status: 200, json: { meta: { currency: 'USD' }, values: this.history() } };
        default:
          return { status: 404, json: { code: 404, status: 'error', message: 'not available' } };
      }
    },
    'www.alphavantage.co': () => ({
      status: 200,
      json: { Symbol: 'AAPL', AssetType: 'Common Stock', Name: 'Apple Inc.', Exchange: 'NASDAQ', Currency: 'USD', Country: 'USA', Sector: 'TECHNOLOGY' },
    }),
    'api.frankfurter.dev': (url) => {
      const range = /\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
      if (url.pathname === '/v1/latest') return { status: 200, json: { base: 'EUR', date: new Date(this.clock()).toISOString().slice(0, 10), rates: { USD: 1.16, GBP: 0.87 } } };
      return range ? { status: 200, json: { base: 'EUR', rates: { [range[1]!]: { USD: 1.15, GBP: 0.86 } } } } : { status: 404 };
    },
  };

  private history(): { datetime: string; close: string }[] {
    return Array.from({ length: 5 }, (_, i) => ({ datetime: new Date(this.clock() - (4 - i) * 86_400_000).toISOString().slice(0, 10), close: String(100 + i) }));
  }
}
