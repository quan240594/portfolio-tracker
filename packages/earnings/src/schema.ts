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

const fieldShape = {
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
};

export const extractionSchema = z.preprocess(withoutNulls, z.object(fieldShape));

export type Extraction = z.infer<typeof extractionSchema>;
export type ExtractedPair = z.infer<typeof pair>;

/** A model sometimes prints a figure as a JSON number (`20.7`): in the lenient reading it is the text the release shows. */
function numbersAsText(input: unknown): unknown {
  if (typeof input === 'number') return String(input);
  if (Array.isArray(input)) return input.map((entry) => numbersAsText(entry));
  if (input !== null && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, numbersAsText(value)]));
  return input;
}

type FieldSchema = (typeof fieldShape)[keyof typeof fieldShape];

/** One field, or, for a list, the entries that are valid (one bad entry does not cost the others). */
function validPart(schema: FieldSchema, value: unknown): unknown {
  const whole = schema.safeParse(value);
  if (whole.success) return whole.data;
  if (!Array.isArray(value)) return undefined;
  const kept = value.filter((entry) => schema.safeParse([entry]).success);
  const again = kept.length === 0 ? undefined : schema.safeParse(kept);
  return again?.success ? again.data : undefined;
}

/**
 * What the model answered, as far as it is usable: the strict reading first; when that fails (one malformed field) every valid field and
 * list entry is kept and the rest dropped. `undefined` when nothing at all is usable (not an object, or no valid field).
 */
export function parseExtraction(input: unknown): { extraction: Extraction; lenient: boolean } | undefined {
  const strict = extractionSchema.safeParse(input);
  if (strict.success) return { extraction: strict.data, lenient: false };
  const cleaned = withoutNulls(numbersAsText(input));
  if (cleaned === null || typeof cleaned !== 'object' || Array.isArray(cleaned)) return undefined;
  const record = cleaned as Record<string, unknown>;
  const entries = (Object.entries(fieldShape) as [string, FieldSchema][]).flatMap(([key, schema]) => {
    const part = record[key] === undefined ? undefined : validPart(schema, record[key]);
    return part === undefined ? [] : [[key, part] as const];
  });
  return entries.length === 0 ? undefined : { extraction: Object.fromEntries(entries) as Extraction, lenient: true };
}

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
