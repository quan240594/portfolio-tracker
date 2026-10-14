import type {
  DividendEvent,
  EodPrice,
  FxDay,
  FxRates,
  ImportStatus,
  InstrumentProfile,
  Portfolio,
  Quote,
  Transaction,
  TransactionsChangedDetail,
} from '@portfolio/shared';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { Deps } from '../deps.js';
import type { EventPublisher } from '../events.js';
import type { UploadUrlSigner } from '../presigner.js';
import type { Repository } from '../repository.js';
import { InMemoryManagementRepository } from './management-fakes.js';

export class InMemoryRepository implements Repository {
  portfolios: Portfolio[] = [];
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

  listPortfolios(userId: string) {
    return Promise.resolve(this.portfolios.filter((p) => p.userId === userId).map((p) => ({ ...p })));
  }
  getPortfolio(userId: string, portfolioId: string) {
    const p = this.portfolios.find((x) => x.userId === userId && x.portfolioId === portfolioId);
    return Promise.resolve(p ? { ...p } : null);
  }
  createPortfolio(portfolio: Portfolio) {
    if (this.portfolios.some((p) => p.userId === portfolio.userId && p.portfolioId === portfolio.portfolioId)) return Promise.resolve(false);
    this.portfolios.push({ ...portfolio });
    return Promise.resolve(true);
  }
  renamePortfolio(userId: string, portfolioId: string, name: string, updatedAt: string) {
    const p = this.portfolios.find((x) => x.userId === userId && x.portfolioId === portfolioId);
    if (!p) return Promise.resolve(null);
    Object.assign(p, { name, updatedAt });
    return Promise.resolve({ ...p });
  }
  deletePortfolio(userId: string, portfolioId: string) {
    this.portfolios = this.portfolios.filter((p) => !(p.userId === userId && p.portfolioId === portfolioId));
    return Promise.resolve();
  }
  listTransactions(userId: string, portfolioId?: string) {
    return Promise.resolve(
      this.transactions
        .filter((t) => t.userId === userId && (portfolioId === undefined || t.portfolioId === portfolioId))
        .map((t) => ({ ...t })),
    );
  }
  findTransaction(userId: string, id: string) {
    return Promise.resolve(this.transactions.find((t) => t.userId === userId && t.id === id) ?? null);
  }
  putTransaction(txn: Transaction) {
    this.transactions.push(txn);
    return Promise.resolve();
  }
  deleteTransaction(txn: Transaction) {
    this.transactions = this.transactions.filter((t) => !(t.userId === txn.userId && t.id === txn.id));
    return Promise.resolve();
  }
  async deleteTransactions(txns: readonly Transaction[]) {
    for (const t of txns) await this.deleteTransaction(t);
  }
  getQuotes(symbols: string[]) {
    return Promise.resolve(Object.fromEntries(symbols.filter((s) => this.quotes[s]).map((s) => [s, this.quotes[s]!])));
  }
  getProfiles(symbols: string[]) {
    return Promise.resolve(Object.fromEntries(symbols.filter((s) => this.profiles[s]).map((s) => [s, this.profiles[s]!])));
  }
  getFx(base: string) {
    return Promise.resolve(this.fx?.base === base ? this.fx : null);
  }
  getFxHistory(base: string, from: string, to: string) {
    return Promise.resolve(
      this.fxDays
        .filter((d) => d.base === base && d.date >= from && d.date <= to)
        .sort((a, b) => a.date.localeCompare(b.date)),
    );
  }
  getEod(symbol: string, from: string, to: string) {
    return Promise.resolve(this.eod.filter((e) => e.symbol === symbol && e.date >= from && e.date <= to));
  }
  getDividendEvents(symbol: string) {
    return Promise.resolve(this.dividendEvents.filter((e) => e.symbol === symbol));
  }
  registerUser(userId: string) {
    this.users.add(userId);
    return Promise.resolve();
  }
  trackTickers(tickers: { symbol: string; currency?: string }[]) {
    for (const t of tickers) this.tracked.set(t.symbol, t.currency ?? '');
    return Promise.resolve();
  }
  putImport(status: ImportStatus) {
    this.imports.set(`${status.userId}/${status.importId}`, status);
    return Promise.resolve();
  }
  getImport(userId: string, importId: string) {
    return Promise.resolve(this.imports.get(`${userId}/${importId}`) ?? null);
  }
}

export class RecordingPublisher implements EventPublisher {
  published: TransactionsChangedDetail[] = [];
  transactionsChanged(detail: TransactionsChangedDetail) {
    this.published.push(detail);
    return Promise.resolve();
  }
}

export class FakeSigner implements UploadUrlSigner {
  signCsvUpload(key: string, expiresInSeconds: number) {
    return Promise.resolve(`https://bucket.example/${key}?X-Amz-Expires=${expiresInSeconds}`);
  }
}

export function fakeDeps(overrides: Partial<Deps> = {}) {
  const repo = new InMemoryRepository();
  const mgmt = new InMemoryManagementRepository();
  const events = new RecordingPublisher();
  let n = 0;
  const deps: Deps = {
    repo,
    mgmt,
    events,
    signer: new FakeSigner(),
    config: { baseCurrency: 'EUR', authMode: 'demo', demoUserId: 'demo', corsAllowedOrigin: 'http://localhost:5173' },
    now: () => new Date('2026-06-15T12:00:00.000Z'),
    uuid: () => `uuid-${++n}`,
    ...overrides,
  };
  return { deps, repo, mgmt, events };
}

const serializeBody = (body: unknown): string | undefined => {
  if (body === undefined) return undefined;
  return typeof body === 'string' ? body : JSON.stringify(body);
};

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
    body: serializeBody(opts.body),
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
  portfolioId: 'default',
  fee: 0,
  currency: 'EUR',
  createdAt: `${t.date}T10:00:00.000Z`,
  ...t,
});

export const portfolio = (p: Partial<Portfolio> & Pick<Portfolio, 'portfolioId' | 'name'>): Portfolio => ({
  userId: 'demo',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  ...p,
});
