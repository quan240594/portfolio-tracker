import { generateVapidKeys } from '@portfolio/platform';
import { FakeSec, type FilingSpec } from '@portfolio/earnings/testing';

/**
 * Network fakes of the tests (no real network, no real accounts): GitHub's OAuth endpoints and the Trading 212 REST API.
 * They are plain functions from a minimal request to a plain reply, so the same fakes serve the Node tests (injected
 * `fetch`) and the workerd tests (Miniflare's `outboundService`), each side turning the reply into its own `Response`.
 */
import { pngBytes } from '@portfolio/platform/testing';

export interface FakeRequest {
  url: string;
  method: string;
  header(name: string): string | null;
  /** The request body (empty for a GET). */
  body: Uint8Array;
}

export interface FakeReply {
  status: number;
  json?: unknown;
  /** A binary body (an image); wins over `json`. */
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

export type FakeService = (request: FakeRequest) => FakeReply | undefined;

/** Test values only: none of these is a real id, secret or token. */
/** A VAPID key pair generated once per test run (the Hub signs with the private half, the fake push service never needs it). */
export const TEST_VAPID = await generateVapidKeys();
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
  /** The dividend history the next sync reads (Trading 212 `history/dividends` items). */
  dividends: unknown[] = [];
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
        return { items: this.dividends };
      case 'history/transactions':
        return { items: [] };
      case 'positions':
        return this.positions;
      case 'metadata/instruments':
        return [
          { ticker: 'SAPd_EQ', type: 'STOCK', isin: 'DE0007164600', name: 'SAP SE', shortName: 'SAP', currencyCode: 'EUR' },
          { ticker: 'AAPL_US_EQ', type: 'STOCK', isin: 'US0378331005', name: 'Apple Inc', shortName: 'AAPL', currencyCode: 'USD' },
        ];
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

export interface ReceivedPush {
  url: string;
  authorization: string | null;
  ttl: string | null;
  contentEncoding: string | null;
  body: Uint8Array;
}

/** A push service (FCM's host): records every message and answers 201, or the status set for the endpoint URL. Bodies are encrypted: tests decrypt them with the subscriber's key. */
export class FakePush {
  readonly received: ReceivedPush[] = [];
  /** Status per endpoint URL; anything else is accepted (201). */
  readonly answers = new Map<string, number>();

  readonly service: FakeService = (request) => {
    if (new URL(request.url).host !== 'fcm.googleapis.com') return undefined;
    this.received.push({ url: request.url, authorization: request.header('authorization'), ttl: request.header('ttl'), contentEncoding: request.header('content-encoding'), body: request.body });
    return { status: this.answers.get(request.url) ?? 201 };
  };

  /** Messages for one endpoint URL, oldest first. */
  to(url: string): ReceivedPush[] {
    return this.received.filter((message) => message.url === url);
  }
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
export const EODHD_KEY = 'test-eodhd-key';
/** A London ETF: EODHD quotes its history in pence (GBX), the app must hold it in pounds. */
export const LONDON_EODHD_SYMBOL = 'SMGB.LSE';
export const LONDON_PENCE = [3000, 3012.5, 3025, 3040] as const;
/** The four latest days up to the clock's day, so the rows always fall inside the history window the enrichment asks for. */
export const londonPenceCloses = (clockMs: number): [string, number][] =>
  LONDON_PENCE.map((close, i) => [new Date(clockMs - (LONDON_PENCE.length - 1 - i) * 86_400_000).toISOString().slice(0, 10), close]);

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
    'eodhd.com': (url) => {
      if (url.searchParams.get('api_token') !== EODHD_KEY) return { status: 401, json: { message: 'bad key' } };
      if (url.pathname.startsWith('/api/search/')) return { status: 200, json: [{ Code: 'SMGB', Exchange: 'LSE', Name: 'London Test ETF', Type: 'ETF', Country: 'UK', Currency: 'GBP' }] };
      if (url.pathname === `/api/eod/${LONDON_EODHD_SYMBOL}`) return { status: 200, json: londonPenceCloses(this.clock()).map(([date, close]) => ({ date, close })) };
      if (url.pathname === `/api/real-time/${LONDON_EODHD_SYMBOL}`) return { status: 200, json: { code: LONDON_EODHD_SYMBOL, close: LONDON_PENCE.at(-1), previousClose: LONDON_PENCE.at(-2), timestamp: Math.floor(this.clock() / 1000) } };
      if (url.pathname.startsWith('/api/div/')) return { status: 200, json: [] };
      return { status: 404, json: { message: 'not available' } };
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

/** The host of the (undocumented) Trading 212 logo bucket and a made-up one for the `LOGO_T212_BASE` override scenario. */
export const T212_BUCKET_HOST = 'trading212equities.s3.eu-central-1.amazonaws.com';
export const T212_FAKE_BUCKET_HOST = 'fake-bucket.test';

/**
 * The keyless icon services the Hub's logo lookups reach (no real network): the fake Trading 212 bucket answers a 240 px PNG for the
 * tickers in `tickers`; Google's favicon endpoint answers a 128 px PNG for the
 * domains in `known`, everything else is a 404; DuckDuckGo's icon endpoint has nothing, and the token-based service answers only a request that carries `LOGO_DEV_TEST_TOKEN`. Every request is recorded, so a test can
 * count the lookups that left the Hub.
 */
export const LOGO_DEV_TEST_TOKEN = 'test-logodev-token';

export class FakeLogos {
  readonly requests: string[] = [];
  /** Domains the fake Google service has a logo for. */
  readonly known = new Set(['apple.com', 'ishares.com']);
  readonly png = pngBytes(128, 128);
  /** Trading 212 tickers the fake bucket has a logo for (`<ticker>.png`). */
  readonly tickers = new Set(['SAPd_EQ', 'AAPL_US_EQ']);
  readonly t212Png = pngBytes(240, 240, 3000);

  readonly service: FakeService = (request) => {
    const url = new URL(request.url);
    if (url.host === T212_BUCKET_HOST || url.host === T212_FAKE_BUCKET_HOST) {
      this.requests.push(request.url);
      const ticker = url.pathname.slice(1).replace(/\.png$/, '');
      return this.tickers.has(ticker) ? { status: 200, bytes: this.t212Png, headers: { 'content-type': 'image/png' } } : { status: 404, json: null };
    }
    if (url.host === 'www.google.com' && url.pathname === '/s2/favicons') {
      this.requests.push(request.url);
      return this.known.has(url.searchParams.get('domain') ?? '') ? { status: 200, bytes: this.png, headers: { 'content-type': 'image/png' } } : { status: 404, json: null };
    }
    if (url.host === 'img.logo.dev') {
      this.requests.push(request.url);
      const allowed = url.searchParams.get('token') === LOGO_DEV_TEST_TOKEN && this.known.has(url.pathname.slice(1));
      return allowed ? { status: 200, bytes: this.png, headers: { 'content-type': 'image/png' } } : { status: 404, json: null };
    }
    if (url.host === 'icons.duckduckgo.com') {
      this.requests.push(request.url);
      return { status: 404, json: null };
    }
    return undefined;
  };
}

/**
 * The SEC (company tickers, submissions, filing index and documents) and Alpha Vantage's `EARNINGS` function over the invented releases of
 * `@portfolio/earnings/testing`; every request is recorded with its User-Agent. Alpha Vantage's other functions are left to `FakePrices`.
 */
export class FakeSecService {
  readonly sec: FakeSec;
  /** Alpha Vantage `EARNINGS` answers per symbol; none by default (no estimate available). */
  readonly estimates = new Map<string, unknown>();
  readonly estimateRequests: string[] = [];

  constructor(filings: readonly FilingSpec[], tickers: Record<string, { cik: number; title: string }>) {
    this.sec = new FakeSec(filings, tickers);
  }

  get requests() {
    return this.sec.requests;
  }

  readonly service: FakeService = (request) => {
    const url = new URL(request.url);
    if (url.host === 'www.alphavantage.co' && url.searchParams.get('function') === 'EARNINGS') {
      this.estimateRequests.push(url.searchParams.get('symbol') ?? '');
      return { status: 200, json: this.estimates.get(url.searchParams.get('symbol') ?? '') ?? { quarterlyEarnings: [] } };
    }
    if (url.host !== 'www.sec.gov' && url.host !== 'data.sec.gov') return undefined;
    const reply = this.sec.handle(request.url, request.header('user-agent') ?? undefined, request.header('accept-encoding') ?? undefined);
    return { status: reply.status, bytes: new TextEncoder().encode(reply.body), headers: reply.headers };
  };
}
