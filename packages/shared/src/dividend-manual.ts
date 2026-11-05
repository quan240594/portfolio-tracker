/**
 * Dividend dates the owner enters by hand ("Add dividend date" on the Calendar page): the workaround for a payer whose dividend the
 * data providers do not list yet. They are declared events with `source: 'manual'`, stored per user (never in the shared ticker
 * partition, so no other user sees them) and added to the stored events when the calendar is built (`withManualDividends`): a provider
 * record for the same ex-date that has an amount replaces the entry, otherwise the entry stays.
 *
 * - POST   /calendar/dividends                      `{symbol, exDate, payDate?, amount?, currency?}` → 201 the stored event (the same symbol and
 *                                                    ex-date again edits it); 400 for an invalid body or a symbol that is not held; 422 when the pay date is before the ex-date
 * - DELETE /calendar/dividends/{symbol}/{exDate}    → 204, 404 when there is no such entry
 *
 * Stored: `USER#{userId}` / `MDIV#{symbol}#{exDate}`, entityType `MANUAL_DIVIDEND`.
 */
import { z } from 'zod';
import { currencySchema, isoDateSchema, symbolSchema } from './schemas.js';
import { MANUAL_DIVIDEND_SOURCE } from './dividend-merge.js';
import type { DividendEvent } from './types.js';

export const MANUAL_DIVIDEND_ROUTES = {
  addManualDividend: 'POST /calendar/dividends',
  removeManualDividend: 'DELETE /calendar/dividends/{symbol}/{exDate}',
} as const;

export const MANUAL_DIVIDEND_ENTITY = 'MANUAL_DIVIDEND';
export const manualDividendKeys = {
  item: (userId: string, symbol: string, exDate: string) => ({ PK: `USER#${userId}`, SK: `MDIV#${symbol}#${exDate}` }),
  prefix: 'MDIV#',
} as const;

/** A stored entry: the dividend event plus who and when. */
export interface ManualDividend extends DividendEvent {
  userId: string;
  source: typeof MANUAL_DIVIDEND_SOURCE;
  declared: true;
  enteredAt: string;
}

/** Most entries one user may keep (a guard against runaway clients; a portfolio needs a handful). */
export const MAX_MANUAL_DIVIDENDS = 200;

const optionalAmount = z.preprocess((value) => (value === '' || value === null ? undefined : value), z.coerce.number().positive().max(1_000_000).optional());
const optionalDay = z.preprocess((value) => (value === '' || value === null ? undefined : value), isoDateSchema.optional());
const optionalCurrency = z.preprocess((value) => (value === '' || value === null ? undefined : value), currencySchema.optional());

export const addManualDividendSchema = z.object({
  symbol: symbolSchema,
  exDate: isoDateSchema,
  payDate: optionalDay,
  amount: optionalAmount,
  currency: optionalCurrency,
});
export type AddManualDividendRequest = z.input<typeof addManualDividendSchema>;

/** The event the calendar works with (an unknown amount is 0). */
export const manualDividendEvent = (entry: ManualDividend): DividendEvent => ({
  symbol: entry.symbol,
  exDate: entry.exDate,
  ...(entry.payDate === undefined ? {} : { payDate: entry.payDate }),
  amount: entry.amount,
  currency: entry.currency,
  source: MANUAL_DIVIDEND_SOURCE,
  declared: true,
});
