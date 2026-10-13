import {
  buildPositions,
  transactionInputSchema,
  type CreateTransactionResponse,
  type ListTransactionsResponse,
  type Transaction,
} from '@portfolio/shared';
import { HttpError, ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import type { RouteContext } from '../deps.js';

const newestFirst = (a: Transaction, b: Transaction) =>
  b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt);

export async function listTransactions(ctx: RouteContext): Promise<RouteResult> {
  const transactions = (await ctx.deps.repo.listTransactions(ctx.userId)).sort(newestFirst);
  return ok({ transactions } satisfies ListTransactionsResponse);
}

async function publishChange(ctx: RouteContext, symbols: string[], reason: 'CREATED' | 'DELETED'): Promise<void> {
  try {
    await ctx.deps.events.transactionsChanged({ userId: ctx.userId, symbols, reason });
  } catch (err) {
    // The write already succeeded; failing the request would invite duplicate submissions.
    // The scheduled price refresh picks up TRACKED tickers regardless.
    logger.error('Failed to publish TransactionsChanged', { error: err as Error, reason, symbols });
  }
}

export async function createTransaction(ctx: RouteContext): Promise<RouteResult> {
  const input = validate(
    transactionInputSchema.safeParse(parseJsonBody(ctx.body, ctx.isBase64Encoded)),
    'Invalid transaction',
  );
  const { repo, now, uuid } = ctx.deps;
  const txn: Transaction = {
    id: uuid(),
    userId: ctx.userId,
    ...input,
    createdAt: now().toISOString(),
  };
  if (txn.note === undefined) delete txn.note;
  if (txn.fxRate === undefined) delete txn.fxRate;

  const existing = await repo.listTransactions(ctx.userId);
  buildPositions([...existing, txn]); // throws PortfolioError (-> 422) on oversell / mixed currency

  await repo.putTransaction(txn);
  await repo.registerUser(ctx.userId);
  await repo.trackTickers([{ symbol: txn.symbol, currency: txn.currency }]);
  await publishChange(ctx, [txn.symbol], 'CREATED');
  return ok(txn satisfies CreateTransactionResponse, 201);
}

export async function deleteTransaction(ctx: RouteContext): Promise<RouteResult> {
  const id = ctx.pathParams.id!;
  const { repo } = ctx.deps;
  const txn = await repo.findTransaction(ctx.userId, id);
  if (!txn) throw new HttpError(404, 'NOT_FOUND', `Transaction ${id} not found`);

  const remaining = (await repo.listTransactions(ctx.userId)).filter((t) => t.id !== id);
  buildPositions(remaining); // deleting a BUY may leave a later SELL overselling -> 422

  await repo.deleteTransaction(txn);
  await publishChange(ctx, [txn.symbol], 'DELETED');
  return ok(undefined, 204);
}
