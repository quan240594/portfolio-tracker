import { API_ROUTES } from '@portfolio/shared';
import { HttpError, type RouteResult } from './lib/http.js';
import type { RouteContext } from './deps.js';
import * as portfolio from './routes/portfolio.js';
import * as portfolios from './routes/portfolios.js';
import * as transactions from './routes/transactions.js';
import * as imports from './routes/imports.js';

export type RouteHandler = (ctx: RouteContext) => Promise<RouteResult>;
type RouteName = keyof typeof API_ROUTES;

const handlers: Record<RouteName, RouteHandler> = {
  health: () => Promise.resolve({ statusCode: 200, body: { status: 'ok' } }),
  listPortfolios: portfolios.listPortfolios,
  createPortfolio: portfolios.createPortfolio,
  updatePortfolio: portfolios.updatePortfolio,
  deletePortfolio: portfolios.deletePortfolio,
  portfolio: portfolio.getPortfolio,
  holdings: portfolio.getHoldings,
  allocation: portfolio.getAllocation,
  history: portfolio.getHistory,
  dividends: portfolio.getDividends,
  listTransactions: transactions.listTransactions,
  createTransaction: transactions.createTransaction,
  deleteTransaction: transactions.deleteTransaction,
  createImport: imports.createImport,
  getImport: imports.getImport,
};

interface CompiledRoute {
  name: RouteName;
  method: string;
  regex: RegExp;
  params: string[];
  handler: RouteHandler;
}

const compiled: CompiledRoute[] = (Object.entries(API_ROUTES) as [RouteName, string][]).map(([name, spec]) => {
  const [method, path] = spec.split(' ') as [string, string];
  const params: string[] = [];
  const pattern = path.replace(/[.*+?^$()|[\]\\]/g, String.raw`\$&`).replace(/\{(\w+)\}/g, (_m, param: string) => {
    params.push(param);
    return '([^/]+)';
  });
  return { name, method, regex: new RegExp(`^${pattern}$`), params, handler: handlers[name] };
});

/** Normalises the raw path: strips trailing slashes and an optional `/api` prefix (CloudFront path routing). */
export function normalisePath(rawPath: string): string {
  let end = rawPath.length;
  while (end > 0 && rawPath[end - 1] === '/') end--;
  let p = rawPath.slice(0, end) || '/';
  if (p === '/api') p = '/';
  else if (p.startsWith('/api/')) p = p.slice(4);
  return p;
}

export interface MatchedRoute {
  name: RouteName;
  route: string;
  handler: RouteHandler;
  pathParams: Record<string, string>;
}

export function matchRoute(method: string, rawPath: string): MatchedRoute {
  const path = normalisePath(rawPath);
  for (const r of compiled) {
    if (r.method !== method.toUpperCase()) continue;
    const m = r.regex.exec(path);
    if (!m) continue;
    const pathParams: Record<string, string> = {};
    r.params.forEach((p, i) => (pathParams[p] = decodeURIComponent(m[i + 1]!)));
    return { name: r.name, route: API_ROUTES[r.name], handler: r.handler, pathParams };
  }
  throw new HttpError(404, 'NOT_FOUND', `Route not found: ${method.toUpperCase()} ${path}`);
}
