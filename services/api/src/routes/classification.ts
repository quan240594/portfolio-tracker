import {
  CLASSIFICATION_ROUTES,
  MAX_CLASSIFICATION_IMPORT_BYTES,
  assetSymbolSchema,
  classificationFieldsOf,
  classificationImportSchema,
  classificationPutSchema,
  classificationValues,
  hasClassification,
  isMarketSymbol,
  matchClassificationRows,
  sourceOf,
  type ClassificationFields,
  type ClassificationImportResponse,
  type ClassificationInstrument,
  type ClassificationListResponse,
  type ClassificationOverrideItem,
  type ClassificationTarget,
  type InstrumentProfile,
} from '@portfolio/shared';
import { HttpError, ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import type { RouteHandler } from '../router.js';
import { heldSymbols } from './portfolio.js';

const BYTES = new TextEncoder();

function pathSymbol(ctx: RouteContext): string {
  return validate(assetSymbolSchema.safeParse(String(ctx.pathParams.symbol)), 'Invalid symbol');
}

const byText = (a: string, b: string): number => a.localeCompare(b);

/** The instrument as the screens see it: the stored profile with the user's override on top. */
function instrumentOf(symbol: string, profile: InstrumentProfile | undefined, override: ClassificationOverrideItem | undefined, held: ReadonlySet<string>): ClassificationInstrument {
  const base = classificationValues(profile, symbol);
  const fields = override === undefined ? undefined : classificationFieldsOf(override);
  return {
    symbol,
    effective: {
      name: fields?.name ?? base.name,
      assetClass: fields?.assetClass ?? base.assetClass,
      sector: fields?.sector ?? base.sector,
      country: fields?.country ?? base.country,
    },
    base,
    source: profile === undefined ? 'none' : sourceOf(profile),
    isin: profile?.isin ?? null,
    currency: profile?.currency ?? null,
    override: fields ?? null,
    held: held.has(symbol),
    updatedAt: override?.updatedAt ?? null,
  };
}

interface Universe {
  instruments: ClassificationInstrument[];
  overrides: Map<string, ClassificationOverrideItem>;
}

/** The user's held symbols (every portfolio) and the symbols they overrode, with profiles and overrides. */
async function loadUniverse(ctx: RouteContext, extra: readonly string[] = []): Promise<Universe> {
  const { repo, mgmt } = ctx.deps;
  const [transactions, stored] = await Promise.all([repo.listTransactions(ctx.userId), mgmt.listClassificationOverrides(ctx.userId)]);
  const held = new Set(heldSymbols(transactions).filter((symbol) => isMarketSymbol(symbol)));
  const overrides = new Map(stored.map((item) => [item.symbol, item]));
  const symbols = [...new Set([...held, ...overrides.keys(), ...extra])].sort(byText);
  const profiles = symbols.length === 0 ? {} : await repo.getProfiles(symbols);
  return { instruments: symbols.map((symbol) => instrumentOf(symbol, profiles[symbol], overrides.get(symbol), held)), overrides };
}

export async function listClassification(ctx: RouteContext): Promise<RouteResult> {
  const { instruments } = await loadUniverse(ctx);
  return ok({ instruments } satisfies ClassificationListResponse);
}

/** Tells the price service (when the deployment has one) that the history symbol of `symbol` changed; nothing happens when it did not. */
async function notifyHistorySymbol(ctx: RouteContext, symbol: string, previous: string | undefined, next: string | undefined): Promise<void> {
  if (previous === next) return;
  await ctx.deps.historySymbols?.changed(symbol, next ?? null);
}

export async function putClassification(ctx: RouteContext): Promise<RouteResult> {
  const symbol = pathSymbol(ctx);
  const fields = validate(classificationPutSchema.safeParse(parseJsonBody(ctx.body)), 'Invalid classification');
  const { mgmt, now } = ctx.deps;
  const existing = (await mgmt.getClassificationOverrides(ctx.userId, [symbol]))[symbol];
  const ts = now().toISOString();
  if (hasClassification(fields)) {
    // Identity comes from the authenticated context and the path only, never from the body.
    const item: ClassificationOverrideItem = { ...fields, userId: ctx.userId, symbol, createdAt: existing?.createdAt ?? ts, updatedAt: ts };
    await mgmt.putClassificationOverrides([item]);
  } else {
    // Only a cleared price history symbol was sent: nothing is left to override.
    await mgmt.deleteClassificationOverride(ctx.userId, symbol);
  }
  await notifyHistorySymbol(ctx, symbol, existing?.historySymbol, fields.historySymbol);
  const { instruments } = await loadUniverse(ctx, [symbol]);
  return ok(instruments.find((instrument) => instrument.symbol === symbol));
}

export async function deleteClassification(ctx: RouteContext): Promise<RouteResult> {
  const symbol = pathSymbol(ctx);
  const existing = (await ctx.deps.mgmt.getClassificationOverrides(ctx.userId, [symbol]))[symbol];
  await ctx.deps.mgmt.deleteClassificationOverride(ctx.userId, symbol);
  await notifyHistorySymbol(ctx, symbol, existing?.historySymbol, undefined);
  return ok(undefined, 204);
}

const sameFields = (a: ClassificationFields, b: ClassificationFields): boolean => JSON.stringify(classificationFieldsOf(a)) === JSON.stringify(classificationFieldsOf(b));

export async function importClassification(ctx: RouteContext): Promise<RouteResult> {
  if (ctx.body !== undefined && BYTES.encode(ctx.body).byteLength > MAX_CLASSIFICATION_IMPORT_BYTES) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `The import is larger than ${MAX_CLASSIFICATION_IMPORT_BYTES} bytes`);
  }
  const { dryRun, rows } = validate(classificationImportSchema.safeParse(parseJsonBody(ctx.body)), 'Invalid classification import');
  const { instruments, overrides } = await loadUniverse(ctx);
  const targets: ClassificationTarget[] = instruments.map((instrument) => ({
    symbol: instrument.symbol,
    ...(instrument.isin === null ? {} : { isin: instrument.isin }),
    ...(instrument.currency === null ? {} : { currency: instrument.currency }),
    current: instrument.effective,
  }));
  const { matched, unmatched } = matchClassificationRows(rows, targets);
  const ts = ctx.deps.now().toISOString();
  const items = matched.flatMap((match): ClassificationOverrideItem[] => {
    const existing = overrides.get(match.symbol);
    const fields = { ...(existing === undefined ? {} : classificationFieldsOf(existing)), ...match.fields };
    if (existing !== undefined && sameFields(existing, fields)) return [];
    return [{ ...fields, userId: ctx.userId, symbol: match.symbol, createdAt: existing?.createdAt ?? ts, updatedAt: ts }];
  });
  if (!dryRun && items.length > 0) await ctx.deps.mgmt.putClassificationOverrides(items);
  return ok({ dryRun, matched, unmatched, applied: dryRun ? 0 : items.length } satisfies ClassificationImportResponse);
}

export const classificationHandlers: Record<keyof typeof CLASSIFICATION_ROUTES, RouteHandler> = {
  classificationList: listClassification,
  classificationPut: putClassification,
  classificationDelete: deleteClassification,
  classificationImport: importClassification,
};
