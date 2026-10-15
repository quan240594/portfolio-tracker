/**
 * Response shapes of the Trading 212 public API (https://docs.trading212.com/_bundle/api.yaml), reduced to the
 * fields the sync needs. Structure is validated strictly; enum-like fields are plain strings so values added by
 * Trading 212 later (new fill, tax or dividend types) never break parsing and are handled by the mapper instead.
 */
import { z } from 'zod';

const id = z.union([z.number(), z.string().min(1)]).transform(String);
const optionalNumber = z.number().nullish().transform((v) => v ?? undefined);

export const instrumentSchema = z.object({
  ticker: z.string().min(1),
  isin: z.string().nullish().transform((v) => v ?? undefined),
  name: z.string().nullish().transform((v) => v ?? undefined),
  currency: z.string().min(1),
});
export type T212Instrument = z.infer<typeof instrumentSchema>;

const taxSchema = z.object({
  name: z.string().nullish().transform((v) => v ?? undefined),
  quantity: z.number(),
  currency: z.string().nullish().transform((v) => v ?? undefined),
});

const walletImpactSchema = z.object({
  currency: z.string().min(1),
  fxRate: optionalNumber,
  netValue: optionalNumber,
  taxes: z.array(taxSchema).nullish().transform((v) => v ?? []),
});

export const historicalOrderSchema = z.object({
  order: z.object({
    id,
    side: z.string(),
    status: z.string().nullish().transform((v) => v ?? undefined),
    ticker: z.string().nullish().transform((v) => v ?? undefined),
    instrument: instrumentSchema,
  }),
  fill: z
    .object({
      id,
      price: z.number(),
      quantity: z.number(),
      filledAt: z.string().min(1),
      type: z.string().nullish().transform((v) => v ?? undefined),
      walletImpact: walletImpactSchema.nullish().transform((v) => v ?? undefined),
    })
    .nullish()
    .transform((v) => v ?? undefined),
});
export type HistoricalOrder = z.infer<typeof historicalOrderSchema>;

export const dividendSchema = z.object({
  reference: z.string().min(1),
  ticker: z.string().nullish().transform((v) => v ?? undefined),
  instrument: instrumentSchema,
  quantity: z.number(),
  /** Net amount in the account currency. */
  amount: z.number(),
  /** Gross per share in the instrument currency. */
  grossAmountPerShare: z.number(),
  /** The account's primary currency. */
  currency: z.string().min(1),
  tickerCurrency: z.string().nullish().transform((v) => v ?? undefined),
  paidOn: z.string().min(1),
  type: z.string().nullish().transform((v) => v ?? undefined),
});
export type HistoryDividend = z.infer<typeof dividendSchema>;

export const cashTransactionSchema = z.object({
  reference: z.string().nullish().transform((v) => v ?? undefined),
  type: z.string(),
  amount: z.number(),
  currency: z.string().nullish().transform((v) => v ?? undefined),
  dateTime: z.string().min(1),
});
export type CashTransaction = z.infer<typeof cashTransactionSchema>;

export const positionSchema = z.object({
  instrument: instrumentSchema,
  quantity: z.number(),
});
export type OpenPosition = z.infer<typeof positionSchema>;

export const accountSummarySchema = z.object({
  id: id.optional(),
  currency: z.string().min(1),
});
export type AccountSummary = z.infer<typeof accountSummarySchema>;

export const tradableInstrumentSchema = z.object({
  ticker: z.string().min(1),
  workingScheduleId: z.number().nullish().transform((v) => v ?? undefined),
});
export type TradableInstrument = z.infer<typeof tradableInstrumentSchema>;

export const exchangeSchema = z.object({
  name: z.string(),
  workingSchedules: z
    .array(z.object({ id: z.number() }))
    .nullish()
    .transform((v) => v ?? []),
});
export type Exchange = z.infer<typeof exchangeSchema>;

/** Page envelope; items are validated one by one so a single odd record cannot fail a whole sync. */
export const pageSchema = z.object({
  items: z.array(z.unknown()),
  nextPagePath: z.string().nullish().transform((v) => v ?? undefined),
});
