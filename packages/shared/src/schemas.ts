import { z } from 'zod';
import { TRANSACTION_TYPES, ALLOCATION_DIMENSIONS } from './types.js';
import { cashSymbol, isCashSymbol, isCashTransactionType, isCustomSymbol } from './management-api.js';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Invalid calendar date');
const symbol = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9.\-:^=]+$/, 'Invalid symbol')
  .transform((s) => s.toUpperCase());
/** Reserved scope value meaning "every portfolio combined"; never a real portfolio id. */
export const ALL_PORTFOLIOS = 'all';
/** `default` or a lower-case UUID; keeps DynamoDB sort keys free of `#`. */
export const portfolioIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Invalid portfolio id')
  .refine((id) => id !== ALL_PORTFOLIOS, `"${ALL_PORTFOLIOS}" is reserved`);
const portfolioName = z.string().trim().min(1, 'Name is required').max(60);

const currency = z
  .string()
  .trim()
  .length(3)
  .transform((s) => s.toUpperCase());

const transactionFields = z.object({
  date: isoDate,
  type: z.enum(TRANSACTION_TYPES),
  symbol,
  quantity: z.coerce.number().positive(),
  price: z.coerce.number().nonnegative(),
  fee: z.coerce.number().nonnegative().default(0),
  currency,
  note: z.string().max(500).optional(),
  // Empty/null means "not provided" (use the ECB fixing), not 0.
  fxRate: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().positive().optional()),
});

/**
 * Cross-field rules of the management types: cash movements use `CASH.<currency>` with a positive amount, only
 * BUY/SELL/DIVIDEND carry a fee, and the reserved cash/custom symbols are not tradable.
 */
function refineTransactionShape(t: z.infer<typeof transactionFields>, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (isCashTransactionType(t.type)) {
    if (t.symbol !== cashSymbol(t.currency)) issue('symbol', `Cash movements use the symbol ${cashSymbol(t.currency)}`);
    if (t.price <= 0) issue('price', 'Price must be greater than 0 (use 1 and put the amount in quantity)');
  } else if (isCashSymbol(t.symbol) || isCustomSymbol(t.symbol)) {
    issue('symbol', 'CASH.* and CUSTOM:* symbols are reserved');
  }
  if (!['BUY', 'SELL', 'DIVIDEND'].includes(t.type) && t.fee !== 0) issue('fee', `Fee is not applicable to ${t.type}`);
}

export const transactionInputSchema = transactionFields
  .extend({ portfolioId: portfolioIdSchema })
  .superRefine(refineTransactionShape);
export type TransactionInput = z.infer<typeof transactionInputSchema>;

/** CSV header (order-insensitive, case-insensitive): date,type,symbol,quantity,price,fee,currency[,note][,fxRate] */
export const CSV_COLUMNS = ['date', 'type', 'symbol', 'quantity', 'price', 'fee', 'currency', 'note', 'fxRate'] as const;
/** CSV rows carry no portfolioId: the whole import targets the portfolio chosen in POST /imports. */
export const csvRowSchema = transactionFields
  .extend({
    type: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .pipe(z.enum(TRANSACTION_TYPES)),
    fee: z.preprocess((v) => (v === '' || v == null ? 0 : v), z.coerce.number().nonnegative()),
    note: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(500).optional()),
    fxRate: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().positive().optional()),
  })
  .superRefine(refineTransactionShape);

/** Optional `?portfolioId=` on read endpoints; omitted or `all` = every portfolio combined. */
export const portfolioScopeSchema = z.object({
  portfolioId: z.union([z.literal(ALL_PORTFOLIOS), portfolioIdSchema]).optional(),
});

export const allocationQuerySchema = portfolioScopeSchema.extend({
  by: z.enum(ALLOCATION_DIMENSIONS).default('assetClass'),
});

export const HISTORY_RANGES = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];
export const historyQuerySchema = portfolioScopeSchema.extend({
  range: z.enum(HISTORY_RANGES).default('1Y'),
});

export const createPortfolioSchema = z.object({ name: portfolioName });
export const updatePortfolioSchema = z.object({ name: portfolioName });

export const createImportSchema = z.object({
  portfolioId: portfolioIdSchema,
  fileName: z
    .string()
    .min(1)
    .max(200)
    .regex(/\.csv$/i, 'Only .csv files are supported'),
});

export { isoDate as isoDateSchema, symbol as symbolSchema, currency as currencySchema };
