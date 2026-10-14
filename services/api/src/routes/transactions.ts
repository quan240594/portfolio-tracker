import {
  buildPositions,
  marketSymbols,
  transactionInputSchema,
  type CreateTransactionResponse,
  type ListTransactionsResponse,
  type Transaction,
} from '@portfolio/shared';
import { HttpError, ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { publishChange } from './changes.js';
import { assertCurrencyConsistency, requirePortfolio, scopedTransactions } from './portfolios.js';

const newestFirst = (a: Transaction, b: Transaction) =>
  b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt);

export async function listTransactions(ctx: RouteContext): Promise<RouteResult> {
  const transactions = (await scopedTransactions(ctx)).sort(newestFirst);
  return ok({ transactions } satisfies ListTransactionsResponse);
}

export async function createTransaction(ctx: RouteContext): Promise<RouteResult> {
  const input = validate(
    transactionInputSchema.safeParse(parseJsonBody(ctx.body, ctx.isBase64Encoded)),
    'Invalid transaction',
  );
  const { repo, now, uuid } = ctx.deps;
  await requirePortfolio(ctx, input.portfolioId);
  const txn: Transaction = {
    id: uuid(),
    userId: ctx.userId,
    ...input,
    createdAt: now().toISOString(),
  };
  if (txn.note === undefined) delete txn.note;
  if (txn.fxRate === undefined) delete txn.fxRate;

  const all = await repo.listTransactions(ctx.userId);
  assertCurrencyConsistency(all, [txn]); // same symbol, different currency in any portfolio -> 422
  // Oversell is checked against the target portfolio only.
  buildPositions([...all.filter((t) => t.portfolioId === txn.portfolioId), txn]);

  await repo.putTransaction(txn);
  await repo.registerUser(ctx.userId);
  await repo.trackTickers(marketSymbols([txn.symbol]).map((symbol) => ({ symbol, currency: txn.currency })));
  await publishChange(ctx, txn.portfolioId, [txn.symbol], 'CREATED');
  return ok(txn satisfies CreateTransactionResponse, 201);
}

export async function deleteTransaction(ctx: RouteContext): Promise<RouteResult> {
  const id = ctx.pathParams.id!;
  const { repo } = ctx.deps;
  const txn = await repo.findTransaction(ctx.userId, id);
  if (!txn) throw new HttpError(404, 'NOT_FOUND', `Transaction ${id} not found`);

  const remaining = (await repo.listTransactions(ctx.userId, txn.portfolioId)).filter((t) => t.id !== id);
  buildPositions(remaining); // deleting a BUY may leave a later SELL of the same portfolio overselling -> 422

  await repo.deleteTransaction(txn);
  await publishChange(ctx, txn.portfolioId, [txn.symbol], 'DELETED');
  return ok(undefined, 204);
}
