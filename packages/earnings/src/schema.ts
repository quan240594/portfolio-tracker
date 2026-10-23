/**
 * What the model is asked for, and what is accepted back. The model only copies values as they are printed in the release (strings with
 * their unit words and signs); it never calculates. The zod schema is strict about sizes and shapes: anything else is rejected or dropped
 * before the verification step compares the values with the text.
 */
import { KPI_TEMPLATES, type KpiTemplateId } from '@portfolio/shared';
import { z } from 'zod';

const printed = z.string().trim().min(1).max(80);
const label = z.string().trim().min(1).max(80);

const pair = z.object({ value: printed, yearAgo: printed.optional() });

/** `null` means "not in the release" to a model; it is the same as leaving the field out. */
function withoutNulls(input: unknown): unknown {
  if (Array.isArray(input)) return input.filter((entry) => entry !== null).map((entry) => withoutNulls(entry));
  if (input !== null && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input)
        .filter(([, value]) => value !== null && value !== '')
        .map(([key, value]) => [key, withoutNulls(value)]),
    );
  }
  return input;
}

const KPI_KEYS = [...new Set(Object.values(KPI_TEMPLATES).flatMap((template) => template.slots.map((slot) => slot.key)))];

export const extractionSchema = z.preprocess(
  withoutNulls,
  z.object({
    period: z.string().trim().min(1).max(40).optional(),
    currency: z.string().trim().min(1).max(8).optional(),
    epsGaap: pair.optional(),
    epsAdjusted: pair.optional(),
    revenue: pair.optional(),
    operatingIncome: pair.optional(),
    operatingMargin: pair.optional(),
    netIncome: pair.optional(),
    operatingCashFlow: pair.optional(),
    capex: pair.optional(),
    freeCashFlow: pair.optional(),
    dilutedShares: pair.optional(),
    kpis: z.array(z.object({ key: z.string().max(40), value: printed, yearAgo: printed.optional() })).max(16).optional(),
    guidance: z
      .array(z.object({ label, period: z.string().trim().max(60).optional(), low: printed.optional(), high: printed.optional(), point: printed.optional() }))
      .max(10)
      .optional(),
    segments: z.array(z.object({ name: label, value: printed, yearAgo: printed.optional() })).max(10).optional(),
    keyUpdates: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
    quote: z.object({ text: z.string().trim().min(1).max(400), speaker: z.string().trim().max(80).optional() }).optional(),
  }),
);

export type Extraction = z.infer<typeof extractionSchema>;
export type ExtractedPair = z.infer<typeof pair>;

const STRING = { type: 'string' } as const;
const PAIR_SCHEMA = { type: 'object', properties: { value: STRING, yearAgo: STRING }, required: ['value'] } as const;

/** The JSON schema of `response_format` (Workers AI JSON mode): the same shape as `extractionSchema`, with the template's KPI keys. */
export function extractionJsonSchema(template: KpiTemplateId): Record<string, unknown> {
  const keys = KPI_TEMPLATES[template].slots.map((slot) => slot.key);
  return {
    type: 'object',
    properties: {
      period: STRING,
      currency: STRING,
      epsGaap: PAIR_SCHEMA,
      epsAdjusted: PAIR_SCHEMA,
      revenue: PAIR_SCHEMA,
      operatingIncome: PAIR_SCHEMA,
      operatingMargin: PAIR_SCHEMA,
      netIncome: PAIR_SCHEMA,
      operatingCashFlow: PAIR_SCHEMA,
      capex: PAIR_SCHEMA,
      freeCashFlow: PAIR_SCHEMA,
      dilutedShares: PAIR_SCHEMA,
      kpis: {
        type: 'array',
        items: { type: 'object', properties: { key: keys.length > 0 ? { type: 'string', enum: keys } : STRING, value: STRING, yearAgo: STRING }, required: ['key', 'value'] },
      },
      guidance: {
        type: 'array',
        items: { type: 'object', properties: { label: STRING, period: STRING, low: STRING, high: STRING, point: STRING }, required: ['label'] },
      },
      segments: { type: 'array', items: { type: 'object', properties: { name: STRING, value: STRING, yearAgo: STRING }, required: ['name', 'value'] } },
      keyUpdates: { type: 'array', items: STRING },
      quote: { type: 'object', properties: { text: STRING, speaker: STRING }, required: ['text'] },
    },
  };
}

/** Every KPI key any template defines (the verification drops keys the template of the symbol does not have). */
export const ALL_KPI_KEYS: readonly string[] = KPI_KEYS;
