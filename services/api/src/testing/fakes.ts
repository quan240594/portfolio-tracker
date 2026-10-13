import type {
  DividendEvent,
  EodPrice,
  FxDay,
  FxRates,
  ImportStatus,
  InstrumentProfile,
  Quote,
  Transaction,
  TransactionsChangedDetail,
} from '@portfolio/shared';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { Deps } from '../deps.js';
import type { EventPublisher } from '../events.js';
import type { UploadUrlSigner } from '../presigner.js';
import type { Repository } from '../repository.js';

export class InMemoryRepository implements Repository {
  transactions: Transaction[] = [];
  quotes: Record<string, Quote> = {};
  profiles: Record<string, InstrumentProfile> = {};
  fx: FxRates | null = null;
  fxDays: FxDay[] = [];
  eod: EodPrice[] = [];
  dividendEvents: DividendEvent[] = [];
  users = new Set<string>();
  tracked = new Map<string, string>();
  imports = new Map<string, ImportStatus>();

  async listTransactions(userId: string) {
    return this.transactions.filter((t) => t.userId === userId).map((t) => ({ ...t }));
  }
  async findTransaction(userId: string, id: string) {
    return this.transactions.find((t) => t.userId === userId && t.id === id) ?? null;
  }
  async putTransaction(txn: Transaction) {
    this.transactions.push(txn);
  }
  async deleteTransaction(txn: Transaction) {
    this.transactions = this.transactions.filter((t) => !(t.userId === txn.userId && t.id === txn.id));
  }
  async getQuotes(symbols: string[]) {
    return Object.fromEntries(symbols.filter((s) => this.quotes[s]).map((s) => [s, this.quotes[s]!]));
  }
  async getProfiles(symbols: string[]) {
    return Object.fromEntries(symbols.filter((s) => this.profiles[s]).map((s) => [s, this.profiles[s]!]));
  }
  async getFx(base: string) {
    return this.fx && this.fx.base === base ? this.fx : null;
  }
  async getFxHistory(base: string, from: string, to: string) {
    return this.fxDays
      .filter((d) => d.base === base && d.date >= from && d.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  async getEod(symbol: string, from: string, to: string) {
    return this.eod.filter((e) => e.symbol === symbol && e.date >= from && e.date <= to);
  }
  async getDividendEvents(symbol: string) {
    return this.dividendEvents.filter((e) => e.symbol === symbol);
  }
  async registerUser(userId: string) {
    this.users.add(userId);
  }
  async trackTickers(tickers: { symbol: string; currency: string }[]) {
    for (const t of tickers) this.tracked.set(t.symbol, t.currency);
  }
  async putImport(status: ImportStatus) {
    this.imports.set(`${status.userId}/${status.importId}`, status);
  }
  async getImport(userId: string, importId: string) {
    return this.imports.get(`${userId}/${importId}`) ?? null;
  }
}

export class RecordingPublisher implements EventPublisher {
  published: TransactionsChangedDetail[] = [];
  async transactionsChanged(detail: TransactionsChangedDetail) {
    this.published.push(detail);
  }
}

export class FakeSigner implements UploadUrlSigner {
  async signCsvUpload(key: string, expiresInSeconds: number) {
    return `https://bucket.example/${key}?X-Amz-Expires=${expiresInSeconds}`;
  }
}

export function fakeDeps(overrides: Partial<Deps> = {}) {
  const repo = new InMemoryRepository();
  const events = new RecordingPublisher();
  let n = 0;
  const deps: Deps = {
    repo,
    events,
    signer: new FakeSigner(),
    config: { baseCurrency: 'EUR', demoUserId: 'demo', corsAllowedOrigin: 'http://localhost:5173' },
    now: () => new Date('2026-06-15T12:00:00.000Z'),
    uuid: () => `uuid-${++n}`,
    ...overrides,
  };
  return { deps, repo, events };
}

export function apiEvent(
  method: string,
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; sub?: string } = {},
): APIGatewayProxyEventV2 {
  const event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: new URLSearchParams(opts.query ?? {}).toString(),
    headers: { 'content-type': 'application/json' },
    queryStringParameters: opts.query,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    isBase64Encoded: false,
    requestContext: {
      accountId: '1',
      apiId: 'api',
      domainName: 'x',
      domainPrefix: 'x',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: '',
      timeEpoch: 0,
      ...(opts.sub ? { authorizer: { jwt: { claims: { sub: opts.sub }, scopes: [] } } } : {}),
    },
  };
  return event as APIGatewayProxyEventV2;
}

export const txn = (t: Partial<Transaction> & Pick<Transaction, 'id' | 'date' | 'type' | 'symbol' | 'quantity' | 'price'>): Transaction => ({
  userId: 'demo',
  fee: 0,
  currency: 'EUR',
  createdAt: `${t.date}T10:00:00.000Z`,
  ...t,
});
