import { z } from 'zod';
import { TRANSACTION_TYPES, ALLOCATION_DIMENSIONS } from './types.js';

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
const currency = z
  .string()
  .trim()
  .length(3)
  .transform((s) => s.toUpperCase());

export const transactionInputSchema = z.object({
  date: isoDate,
  type: z.enum(TRANSACTION_TYPES),
  symbol,
  quantity: z.coerce.number().positive(),
  price: z.coerce.number().nonnegative(),
  fee: z.coerce.number().nonnegative().default(0),
  currency,
  note: z.string().max(500).optional(),
});
export type TransactionInput = z.infer<typeof transactionInputSchema>;

/** Required CSV header (order-insensitive, case-insensitive): date,type,symbol,quantity,price,fee,currency[,note] */
export const CSV_COLUMNS = ['date', 'type', 'symbol', 'quantity', 'price', 'fee', 'currency', 'note'] as const;
export const csvRowSchema = transactionInputSchema.extend({
  type: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.enum(TRANSACTION_TYPES)),
  fee: z.preprocess((v) => (v === '' || v == null ? 0 : v), z.coerce.number().nonnegative()),
  note: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(500).optional()),
});

export const allocationQuerySchema = z.object({
  by: z.enum(ALLOCATION_DIMENSIONS).default('assetClass'),
});

export const HISTORY_RANGES = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];
export const historyQuerySchema = z.object({
  range: z.enum(HISTORY_RANGES).default('1Y'),
});

export const createImportSchema = z.object({
  fileName: z
    .string()
    .min(1)
    .max(200)
    .regex(/\.csv$/i, 'Only .csv files are supported'),
});
