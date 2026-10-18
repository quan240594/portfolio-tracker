import {
  ALL_PORTFOLIOS,
  DEFAULT_PORTFOLIO_ID,
  DEFAULT_PORTFOLIO_NAME,
  MAX_PORTFOLIOS,
  PortfolioError,
  createPortfolioSchema,
  portfolioIdSchema,
  portfolioScopeSchema,
  updatePortfolioSchema,
  type ListPortfoliosResponse,
  type Portfolio,
  type PortfolioResponse,
  type Transaction,
} from '@portfolio/shared';
import { HttpError, ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { publishChange } from './changes.js';

const byCreatedAt = (a: Portfolio, b: Portfolio) =>
  a.createdAt.localeCompare(b.createdAt) || a.portfolioId.localeCompare(b.portfolioId);

const notFound = (portfolioId: string) => new HttpError(404, 'NOT_FOUND', `Portfolio ${portfolioId} not found`);

/**
 * Creates the default portfolio for a user without any. The put is conditional, so concurrent first
 * requests are idempotent: the loser reads back the winner's item.
 */
async function createDefaultPortfolio(ctx: RouteContext): Promise<Portfolio> {
  const { repo, now } = ctx.deps;
  const ts = now().toISOString();
  const portfolio: Portfolio = {
    portfolioId: DEFAULT_PORTFOLIO_ID,
    userId: ctx.userId,
    name: DEFAULT_PORTFOLIO_NAME,
    createdAt: ts,
    updatedAt: ts,
  };
  if (await repo.createPortfolio(portfolio)) return portfolio;
  return (await repo.getPortfolio(ctx.userId, DEFAULT_PORTFOLIO_ID)) ?? portfolio;
}

/** All portfolios of the user sorted by createdAt, creating the default one on first use. */
export async function ensurePortfolios(ctx: RouteContext): Promise<Portfolio[]> {
  const portfolios = await ctx.deps.repo.listPortfolios(ctx.userId);
  if (portfolios.length === 0) return [await createDefaultPortfolio(ctx)];
  return portfolios.sort(byCreatedAt);
}

/**
 * Returns the portfolio or throws 404. The default portfolio is created on first use, i.e. when the
 * user has no portfolio at all yet (a deleted default stays deleted once others exist).
 */
export async function requirePortfolio(ctx: RouteContext, portfolioId: string): Promise<Portfolio> {
  const portfolio = await ctx.deps.repo.getPortfolio(ctx.userId, portfolioId);
  if (portfolio) return portfolio;
  if (portfolioId === DEFAULT_PORTFOLIO_ID && (await ctx.deps.repo.listPortfolios(ctx.userId)).length === 0) {
    return createDefaultPortfolio(ctx);
  }
  throw notFound(portfolioId);
}

/**
 * Resolves `?portfolioId=` of read endpoints: undefined (= all portfolios combined) when omitted or
 * `all`, otherwise the id of an existing portfolio (404 if unknown, 400 if malformed).
 */
export async function resolveScope(ctx: RouteContext): Promise<string | undefined> {
  const { portfolioId } = validate(portfolioScopeSchema.safeParse(ctx.query), 'Invalid query parameters');
  if (portfolioId === undefined || portfolioId === ALL_PORTFOLIOS) return undefined;
  return (await requirePortfolio(ctx, portfolioId)).portfolioId;
}

/** Transactions in the requested read scope (one portfolio or all combined). */
export async function scopedTransactions(ctx: RouteContext): Promise<Transaction[]> {
  return ctx.deps.repo.listTransactions(ctx.userId, await resolveScope(ctx));
}

/**
 * A symbol must use the same currency in every portfolio of the user, so the combined view can always
 * be computed. Throws PortfolioError (-> 422) for the first new transaction that breaks the rule.
 */
export function assertCurrencyConsistency(existing: readonly Transaction[], added: readonly Transaction[]): void {
  const currencies = new Map<string, string>();
  for (const t of existing) if (!currencies.has(t.symbol)) currencies.set(t.symbol, t.currency);
  for (const t of added) {
    const known = currencies.get(t.symbol);
    if (known === undefined) currencies.set(t.symbol, t.currency);
    else if (known !== t.currency) throw new PortfolioError(`Mixed currencies for ${t.symbol}: ${known} and ${t.currency}`);
  }
}

const sameName = (a: string, b: string) => a.toLocaleLowerCase('en') === b.toLocaleLowerCase('en');

function assertUniqueName(portfolios: readonly Portfolio[], name: string, exceptId?: string): void {
  const clash = portfolios.find((p) => p.portfolioId !== exceptId && sameName(p.name, name));
  if (clash) throw new HttpError(409, 'CONFLICT', `A portfolio named "${clash.name}" already exists`, { portfolioId: clash.portfolioId });
}

/** Path ids that can never exist (malformed) are reported as unknown rather than as a validation error. */
function pathPortfolioId(ctx: RouteContext): string {
  const id = ctx.pathParams.id!;
  if (!portfolioIdSchema.safeParse(id).success) throw notFound(id);
  return id;
}

export async function listPortfolios(ctx: RouteContext): Promise<RouteResult> {
  return ok({ portfolios: await ensurePortfolios(ctx) } satisfies ListPortfoliosResponse);
}

export async function createPortfolio(ctx: RouteContext): Promise<RouteResult> {
  const { name } = validate(createPortfolioSchema.safeParse(parseJsonBody(ctx.body)), 'Invalid portfolio');
  const { repo, now, uuid } = ctx.deps;
  const existing = await repo.listPortfolios(ctx.userId);
  assertUniqueName(existing, name);
  if (existing.length >= MAX_PORTFOLIOS) {
    throw new HttpError(422, 'UNPROCESSABLE', `A user can have at most ${MAX_PORTFOLIOS} portfolios`);
  }
  const ts = now().toISOString();
  const portfolio: Portfolio = { portfolioId: uuid().toLowerCase(), userId: ctx.userId, name, createdAt: ts, updatedAt: ts };
  if (!(await repo.createPortfolio(portfolio))) {
    throw new HttpError(409, 'CONFLICT', `Portfolio ${portfolio.portfolioId} already exists`);
  }
  return ok(portfolio satisfies PortfolioResponse, 201);
}

export async function updatePortfolio(ctx: RouteContext): Promise<RouteResult> {
  const id = pathPortfolioId(ctx);
  const { name } = validate(updatePortfolioSchema.safeParse(parseJsonBody(ctx.body)), 'Invalid portfolio');
  const { repo, now } = ctx.deps;
  const portfolios = await repo.listPortfolios(ctx.userId);
  if (!portfolios.some((p) => p.portfolioId === id)) throw notFound(id);
  assertUniqueName(portfolios, name, id);
  const updated = await repo.renamePortfolio(ctx.userId, id, name, now().toISOString());
  if (!updated) throw notFound(id); // deleted concurrently
  return ok(updated satisfies PortfolioResponse);
}

export async function deletePortfolio(ctx: RouteContext): Promise<RouteResult> {
  const id = pathPortfolioId(ctx);
  const force = ctx.query.force === 'true';
  const { repo } = ctx.deps;
  const portfolios = await repo.listPortfolios(ctx.userId);
  if (!portfolios.some((p) => p.portfolioId === id)) throw notFound(id);
  if (portfolios.length === 1) {
    throw new HttpError(409, 'LAST_PORTFOLIO', 'Cannot delete the only portfolio');
  }
  const transactions = await repo.listTransactions(ctx.userId, id);
  if (transactions.length > 0 && !force) {
    throw new HttpError(409, 'PORTFOLIO_NOT_EMPTY', `Portfolio ${id} has ${transactions.length} transaction(s); pass force=true to delete them too`, {
      transactionCount: transactions.length,
    });
  }
  // Transactions first: if the cascade fails halfway the portfolio still exists and the delete can be retried.
  if (transactions.length > 0) await repo.deleteTransactions(transactions);
  await ctx.deps.mgmt.deletePortfolioData(ctx.userId, id);
  await repo.deletePortfolio(ctx.userId, id);
  if (transactions.length > 0) {
    await publishChange(ctx, id, [...new Set(transactions.map((t) => t.symbol))].sort((a, b) => a.localeCompare(b)), 'DELETED');
  }
  return ok(undefined, 204);
}
