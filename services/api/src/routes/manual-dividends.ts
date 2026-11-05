import { MAX_MANUAL_DIVIDENDS, addManualDividendSchema, daysBetween, type MANUAL_DIVIDEND_ROUTES, type ManualDividend } from '@portfolio/shared';
import type { RouteContext } from '../deps.js';
import { HttpError, ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import { loadProfiles } from '../lib/profiles.js';
import type { RouteHandler } from '../router.js';

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** How far from today an ex-date may lie: a typo of the year is caught, a dividend declared far ahead is not refused. */
const MAX_DAYS_AWAY = 400;

/** The currency of an entry that names none: the one the symbol is quoted in, else the base currency. */
async function defaultCurrency(ctx: RouteContext, symbol: string): Promise<string> {
  const profile = (await loadProfiles(ctx, [symbol]))[symbol];
  return profile?.currency ?? ctx.deps.config.baseCurrency;
}

/**
 * `POST /calendar/dividends`: the dividend date the user enters by hand for a symbol of theirs (see `dividend-manual.ts`). The same symbol and
 * ex-date again replaces the entry. A symbol that is not held (or never was) is refused: the entry would never show.
 */
export async function addManualDividend(ctx: RouteContext): Promise<RouteResult> {
  const body = validate(addManualDividendSchema.safeParse(parseJsonBody(ctx.body)), 'Invalid dividend date');
  const { repo, mgmt, now } = ctx.deps;
  const today = isoDay(now());
  if (Math.abs(daysBetween(today, body.exDate)) > MAX_DAYS_AWAY) throw new HttpError(422, 'UNPROCESSABLE', `The ex-date must be within ${MAX_DAYS_AWAY} days of today`);
  if (body.payDate !== undefined && body.payDate < body.exDate) throw new HttpError(422, 'UNPROCESSABLE', 'The pay date must not be before the ex-date');
  const transactions = await repo.listTransactions(ctx.userId);
  if (!transactions.some((t) => t.symbol === body.symbol)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${body.symbol} is not in your portfolio`);
  }
  const existing = await mgmt.listManualDividends(ctx.userId);
  if (existing.length >= MAX_MANUAL_DIVIDENDS && !existing.some((entry) => entry.symbol === body.symbol && entry.exDate === body.exDate)) {
    throw new HttpError(422, 'UNPROCESSABLE', `At most ${MAX_MANUAL_DIVIDENDS} dividend dates can be entered`);
  }
  const entry: ManualDividend = {
    userId: ctx.userId,
    symbol: body.symbol,
    exDate: body.exDate,
    ...(body.payDate === undefined ? {} : { payDate: body.payDate }),
    amount: body.amount ?? 0,
    currency: body.currency ?? (await defaultCurrency(ctx, body.symbol)),
    source: 'manual',
    declared: true,
    enteredAt: now().toISOString(),
  };
  await mgmt.putManualDividend(entry);
  const { userId: _userId, ...shown } = entry;
  return ok(shown, 201);
}

/** `DELETE /calendar/dividends/{symbol}/{exDate}`: removes an entry of the user. */
export async function removeManualDividend(ctx: RouteContext): Promise<RouteResult> {
  const symbol = ctx.pathParams.symbol!.toUpperCase();
  const exDate = ctx.pathParams.exDate!;
  if (!(await ctx.deps.mgmt.deleteManualDividend(ctx.userId, symbol, exDate))) {
    throw new HttpError(404, 'NOT_FOUND', `There is no dividend date entered for ${symbol} with ex-date ${exDate}`);
  }
  return ok(undefined, 204);
}

export const manualDividendHandlers: Record<keyof typeof MANUAL_DIVIDEND_ROUTES, RouteHandler> = {
  addManualDividend,
  removeManualDividend,
};
