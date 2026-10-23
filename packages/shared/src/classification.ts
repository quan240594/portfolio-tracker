/**
 * Instrument classification: the owner's per-symbol overrides of the profile fields the allocation views group by.
 *
 * Precedence of what a screen shows for a symbol (see docs/architecture.md "Instrument classification"):
 *   owner override > provider profile > Trading 212 baseline > minimal (derived from the symbol)
 * The first three are applied here (`applyClassificationOverrides`, `mergeProfile`); the stored profile of a symbol is one item shared
 * by all users, the overrides are per user.
 *
 * REST contract (all authenticated, user scoped; errors use the standard envelope):
 * - GET    /classification            held (and overridden) instruments with their effective and base classification
 * - PUT    /classification/{symbol}   body = ClassificationFields (at least one); stores the override, answers the instrument
 * - DELETE /classification/{symbol}   removes the override (204, also when none was stored)
 * - POST   /classification/import     body = ClassificationImportRequest (max 1 MB); `dryRun` only reports what would change
 */
import { z } from 'zod';
import { KPI_TEMPLATE_IDS, type KpiTemplateId } from './earnings.js';
import { normalizeDomain } from './logo-domains.js';
import { isT212Ticker } from './t212-ticker.js';
import { ASSET_CLASSES, PROFILE_SOURCES, type AssetClass, type InstrumentProfile, type ProfileSource } from './types.js';

export const CLASSIFICATION_ROUTES = {
  classificationList: 'GET /classification',
  classificationImport: 'POST /classification/import',
  classificationPut: 'PUT /classification/{symbol}',
  classificationDelete: 'DELETE /classification/{symbol}',
} as const;

// --- Single-table item (PK USER#{userId}, SK CLASS#{symbol}, entityType CLASSIFICATION) ---------------------------------

export const CLASSIFICATION_ENTITY = 'CLASSIFICATION';

export const classificationKeys = {
  override: (userId: string, symbol: string) => ({ PK: `USER#${userId}`, SK: `CLASS#${symbol}` }),
  /** Every override of a user. */
  prefix: 'CLASS#',
} as const;

/**
 * What an owner can override; every field is optional and an absent one falls through to the profile. `domain` is the website
 * domain the company logo is looked up by (stored normalised, e.g. `apple.com`); it is not an allocation field and never reaches the profile.
 */
export interface ClassificationFields {
  name?: string;
  assetClass?: AssetClass;
  sector?: string;
  country?: string;
  domain?: string;
  /** The earnings summary template of the company (see earnings.ts); not a profile field either. */
  kpiTemplate?: KpiTemplateId;
}

export const CLASSIFICATION_FIELDS = ['name', 'assetClass', 'sector', 'country'] as const;
export type ClassificationField = (typeof CLASSIFICATION_FIELDS)[number];

export interface ClassificationOverrideItem extends ClassificationFields {
  userId: string;
  symbol: string;
  createdAt: string;
  updatedAt: string;
}

export const MAX_CLASSIFICATION_IMPORT_BYTES = 1_000_000;
export const MAX_CLASSIFICATION_IMPORT_ROWS = 1000;

const text = (max: number) => z.string().trim().min(1).max(max);

const fieldShape = { name: text(120).optional(), assetClass: z.enum(ASSET_CLASSES).optional(), sector: text(60).optional(), country: text(60).optional() };

/** A website domain or URL the owner typed, stored as the bare normalised domain (`https://www.apple.com/` -> `apple.com`). */
const domainField = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .transform((value, ctx) => {
    const domain = normalizeDomain(value);
    if (domain === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a website domain such as apple.com' });
    return domain ?? z.NEVER;
  });

export const classificationFieldsSchema = z.object({ ...fieldShape, domain: domainField.optional(), kpiTemplate: z.enum(KPI_TEMPLATE_IDS).optional() }).strict();

/** `PUT` body: the fields to store, at least one. */
export const classificationPutSchema = classificationFieldsSchema.refine((fields) => hasClassification(fields), 'Give at least one of name, assetClass, sector, country, website domain or earnings template');

const isin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, 'Invalid ISIN');

/** One normalised row of an import: the browser parsed and mapped the owner's file, the server only matches and stores. */
export const classificationRowSchema = z
  .object({
    ticker: text(30).transform((value) => value.toUpperCase()),
    isin: isin.optional(),
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((value) => value.toUpperCase())
      .optional(),
    ...fieldShape,
  })
  .strict();
export type ClassificationRow = z.infer<typeof classificationRowSchema>;

export const classificationImportSchema = z
  .object({ dryRun: z.boolean().default(false), rows: z.array(classificationRowSchema).min(1).max(MAX_CLASSIFICATION_IMPORT_ROWS) })
  .strict();
export type ClassificationImportRequest = z.input<typeof classificationImportSchema>;

export const hasClassification = (fields: ClassificationFields): boolean => CLASSIFICATION_FIELDS.some((field) => fields[field] !== undefined) || fields.domain !== undefined || fields.kpiTemplate !== undefined;

/** The fields that are set, nothing else (a stored item or a request body may carry other attributes). */
export function classificationFieldsOf(source: ClassificationFields): ClassificationFields {
  const out: ClassificationFields = {};
  if (source.name !== undefined) out.name = source.name;
  if (source.assetClass !== undefined) out.assetClass = source.assetClass;
  if (source.sector !== undefined) out.sector = source.sector;
  if (source.country !== undefined) out.country = source.country;
  if (source.domain !== undefined) out.domain = source.domain;
  if (source.kpiTemplate !== undefined) out.kpiTemplate = source.kpiTemplate;
  return out;
}

// --- Responses ---------------------------------------------------------------------------------------------------------

/** What a screen shows for the instrument, with the stored profile it came from. */
export interface ClassificationValues {
  name: string;
  assetClass: AssetClass;
  sector: string | null;
  country: string | null;
}

export interface ClassificationInstrument {
  symbol: string;
  /** What the allocation views use: the override where there is one, else the profile. */
  effective: ClassificationValues;
  /** The profile alone (provider, Trading 212 baseline or minimal), before the override. */
  base: ClassificationValues;
  /** Where `base` comes from; `none` when the symbol has no stored profile yet. */
  source: ProfileSource | 'none';
  isin: string | null;
  currency: string | null;
  override: ClassificationFields | null;
  /** Whether the user holds the symbol (an override may outlive the position). */
  held: boolean;
  updatedAt: string | null;
}

export interface ClassificationListResponse {
  instruments: ClassificationInstrument[];
}

export type ClassificationUnmatchedReason = 'not-held' | 'ambiguous' | 'isin-mismatch' | 'duplicate' | 'empty';

export interface ClassificationChange {
  field: ClassificationField;
  from: string | null;
  to: string;
}

export interface ClassificationMatch {
  /** Position of the row in the request (0-based). */
  index: number;
  ticker: string;
  symbol: string;
  matchedBy: 'isin' | 'ticker';
  /** The fields the row sets. */
  fields: ClassificationFields;
  /** Only the fields whose effective value differs from today's. */
  changes: ClassificationChange[];
}

export interface ClassificationUnmatched {
  index: number;
  ticker: string;
  isin?: string;
  reason: ClassificationUnmatchedReason;
}

export interface ClassificationImportResponse {
  dryRun: boolean;
  matched: ClassificationMatch[];
  unmatched: ClassificationUnmatched[];
  /** Overrides written (always 0 for a dry run). */
  applied: number;
}

// --- Profile merging and overrides ---------------------------------------------------------------------------------------

const RANK: Readonly<Record<ProfileSource, number>> = { minimal: 0, trading212: 1, provider: 2 };

/** A profile without a source is a provider profile. */
export const sourceOf = (profile: InstrumentProfile | { profileSource?: ProfileSource }): ProfileSource => profile.profileSource ?? 'provider';

export const isProfileSource = (value: unknown): value is ProfileSource => typeof value === 'string' && (PROFILE_SOURCES as readonly string[]).includes(value);

const PROFILE_FIELDS = ['name', 'assetClass', 'sector', 'country', 'exchange', 'currency', 'isin', 'description'] as const;

/** A placeholder is not a real value: the symbol as a name, `OTHER` as a class. */
function usable(field: (typeof PROFILE_FIELDS)[number], profile: InstrumentProfile): boolean {
  const value = profile[field];
  if (value === undefined || value === '') return false;
  if (field === 'name') return value !== profile.symbol;
  return field !== 'assetClass' || value !== 'OTHER';
}

/**
 * Combines two profiles of one symbol. The richer source wins field by field (an equal or higher incoming source overwrites,
 * a lower one only fills what is missing), a placeholder never replaces a real value, and the numeric details and markers of
 * both are kept (the incoming ones win). The result carries the better source.
 */
export function mergeProfile(existing: InstrumentProfile | undefined, incoming: InstrumentProfile): InstrumentProfile {
  if (existing === undefined) return incoming;
  const incomingWins = RANK[sourceOf(incoming)] >= RANK[sourceOf(existing)];
  const [high, low] = incomingWins ? [incoming, existing] : [existing, incoming];
  const merged: Record<string, unknown> = { ...low, ...high };
  for (const field of PROFILE_FIELDS) {
    const pick = [high, low].find((profile) => usable(field, profile)) ?? high;
    if (pick[field] === undefined) delete merged[field];
    else merged[field] = pick[field];
  }
  // The Trading 212 ticker is an identifier, not a rating: whichever profile has a valid one keeps it (the richer first).
  const t212Ticker = [high, low].find((profile) => isT212Ticker(profile.t212Ticker))?.t212Ticker;
  if (t212Ticker === undefined) delete merged.t212Ticker;
  else merged.t212Ticker = t212Ticker;
  merged.profileSource = sourceOf(high);
  return merged as unknown as InstrumentProfile;
}

/**
 * The profiles with the owner's overrides applied. An override of a symbol without a stored profile creates one from the
 * override alone, in the currency of `currencies` (e.g. its quote); without a known currency the override waits for a profile.
 */
export function applyClassificationOverrides(
  profiles: Readonly<Record<string, InstrumentProfile>>,
  overrides: Readonly<Record<string, ClassificationFields>>,
  currencies: Readonly<Record<string, string>> = {},
): Record<string, InstrumentProfile> {
  const out: Record<string, InstrumentProfile> = { ...profiles };
  for (const [symbol, override] of Object.entries(overrides)) {
    // The logo domain and the earnings template are not profile fields: only the four allocation fields are laid over the profile.
    const { domain: _logoDomain, kpiTemplate: _kpiTemplate, ...fields } = classificationFieldsOf(override);
    if (!CLASSIFICATION_FIELDS.some((field) => fields[field] !== undefined)) continue;
    const profile = profiles[symbol];
    if (profile !== undefined) out[symbol] = { ...profile, ...fields };
    else if (currencies[symbol] !== undefined) out[symbol] = { symbol, name: fields.name ?? symbol, assetClass: fields.assetClass ?? 'OTHER', currency: currencies[symbol], ...fields };
  }
  return out;
}

/** The values a screen shows for a profile; `Unknown` is the screens' word for a missing sector or country, kept out of here (null). */
export function classificationValues(profile: InstrumentProfile | undefined, symbol: string): ClassificationValues {
  return { name: profile?.name ?? symbol, assetClass: profile?.assetClass ?? 'OTHER', sector: profile?.sector ?? null, country: profile?.country ?? null };
}

// --- Import matching ---------------------------------------------------------------------------------------------------------

/** One known instrument of the user (held or overridden) an import row can match. */
export interface ClassificationTarget {
  symbol: string;
  isin?: string;
  currency?: string;
  /** Effective values today (override applied), for the change list. */
  current: ClassificationValues;
}

/** Exchange suffixes of the app's symbols (`FWRA.MI`, `ASML.AS`); anything else after a dot is part of the ticker (`BRK.B`). */
const EXCHANGE_SUFFIX = /\.(?:L|AS|DE|PA|MI|MC|SW|BR|LS|VI|HE|ST|CO|OL|IR|TO|AX|F)$/;

/** `FWRA.MI` -> `FWRA`; `BRK-B` and `BRK.B` -> `BRK-B`. */
export function baseTicker(symbol: string): string {
  return symbol.toUpperCase().replace(EXCHANGE_SUFFIX, '').replaceAll('.', '-');
}

const sameValue = (current: string | null, next: string): boolean => current !== null && current.toLowerCase() === next.toLowerCase();

function changesOf(current: ClassificationValues, fields: ClassificationFields): ClassificationChange[] {
  const changes: ClassificationChange[] = [];
  for (const field of CLASSIFICATION_FIELDS) {
    const next = fields[field];
    if (next !== undefined && !sameValue(current[field], next)) changes.push({ field, from: current[field], to: next });
  }
  return changes;
}

type Candidates = { targets: readonly ClassificationTarget[]; by: 'isin' | 'ticker' } | { reason: ClassificationUnmatchedReason };

/** The targets a row may belong to: by ISIN first, then by ticker; a row with an ISIN never matches an instrument with another one. */
function candidatesOf(row: ClassificationRow, targets: readonly ClassificationTarget[]): Candidates {
  const ticker = baseTicker(row.ticker);
  const byIsin = row.isin === undefined ? [] : targets.filter((target) => target.isin === row.isin);
  if (byIsin.length > 0) return { targets: narrow(byIsin, row, ticker), by: 'isin' };
  const byTicker = targets.filter((target) => baseTicker(target.symbol) === ticker);
  const compatible = byTicker.filter((target) => row.isin === undefined || target.isin === undefined);
  if (compatible.length > 0) return { targets: narrow(compatible, row, ticker), by: 'ticker' };
  return { reason: byTicker.length > 0 ? 'isin-mismatch' : 'not-held' };
}

/** Several listings of one instrument: the ticker, then the currency decide. */
function narrow(targets: readonly ClassificationTarget[], row: ClassificationRow, ticker: string): readonly ClassificationTarget[] {
  if (targets.length === 1) return targets;
  const byTicker = targets.filter((target) => baseTicker(target.symbol) === ticker);
  const pool = byTicker.length > 0 ? byTicker : targets;
  const byCurrency = row.currency === undefined ? [] : pool.filter((target) => target.currency?.toUpperCase() === row.currency);
  return byCurrency.length > 0 ? byCurrency : pool;
}

/**
 * Matches the rows of an import to the user's instruments and lists what would change. Never guesses: a row that fits several
 * instruments is `ambiguous`, one whose ISIN contradicts the instrument is `isin-mismatch`, one for a symbol an earlier row
 * already claimed is a `duplicate`, and a row without any classification field is `empty`.
 */
export function matchClassificationRows(
  rows: readonly ClassificationRow[],
  targets: readonly ClassificationTarget[],
): { matched: ClassificationMatch[]; unmatched: ClassificationUnmatched[] } {
  const matched: ClassificationMatch[] = [];
  const unmatched: ClassificationUnmatched[] = [];
  const claimed = new Set<string>();
  const reject = (index: number, row: ClassificationRow, reason: ClassificationUnmatchedReason): void => {
    unmatched.push({ index, ticker: row.ticker, ...(row.isin === undefined ? {} : { isin: row.isin }), reason });
  };
  for (const [index, row] of rows.entries()) {
    const fields = classificationFieldsOf(row);
    const found = hasClassification(fields) ? candidatesOf(row, targets) : { reason: 'empty' as const };
    if ('reason' in found) {
      reject(index, row, found.reason);
      continue;
    }
    const [target, ...others] = found.targets;
    if (target === undefined || others.length > 0) reject(index, row, 'ambiguous');
    else if (claimed.has(target.symbol)) reject(index, row, 'duplicate');
    else {
      claimed.add(target.symbol);
      matched.push({ index, ticker: row.ticker, symbol: target.symbol, matchedBy: found.by, fields, changes: changesOf(target.current, fields) });
    }
  }
  return { matched, unmatched };
}
