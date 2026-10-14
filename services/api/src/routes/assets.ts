import {
  MAX_CUSTOM_ASSETS,
  PortfolioError,
  createCustomAssetSchema,
  customAssetValueLocal,
  isoDateSchema,
  updateCustomAssetSchema,
  upsertValuation,
  valuationSchema,
  toBase,
  type CustomAsset,
  type CustomAssetWithValue,
  type FxRates,
  type ListAssetsResponse,
} from '@portfolio/shared';
import { HttpError, ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { requirePathPortfolio } from './management-data.js';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const byCreatedAt = (a: CustomAsset, b: CustomAsset) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name);

async function latestFx(ctx: RouteContext): Promise<FxRates> {
  const base = ctx.deps.config.baseCurrency;
  return (await ctx.deps.repo.getFx(base)) ?? { base, rates: {}, asOf: ctx.deps.now().toISOString() };
}

/** Adds today's value (asset currency and base currency at the latest FX rate). Missing FX -> 503 via MissingFxRateError. */
function withValue(asset: CustomAsset, fx: FxRates, today: string): CustomAssetWithValue {
  const currentValueLocal = customAssetValueLocal(asset, today);
  return { ...asset, currentValueLocal: Math.round(currentValueLocal * 100) / 100, currentValue: Math.round(toBase(currentValueLocal, asset.currency, fx) * 100) / 100 };
}

async function respond(ctx: RouteContext, asset: CustomAsset, status = 200): Promise<RouteResult> {
  return ok(withValue(asset, await latestFx(ctx), isoDay(ctx.deps.now())), status);
}

async function requireAsset(ctx: RouteContext, portfolioId: string): Promise<CustomAsset> {
  const id = ctx.pathParams.aid!;
  const asset = await ctx.deps.mgmt.getCustomAsset(ctx.userId, portfolioId, id);
  if (!asset) throw new HttpError(404, 'NOT_FOUND', `Asset ${id} not found`);
  return asset;
}

export async function listAssets(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const [assets, fx] = await Promise.all([ctx.deps.mgmt.listCustomAssets(ctx.userId, portfolioId), latestFx(ctx)]);
  const today = isoDay(ctx.deps.now());
  const sortedAssets = [...assets].sort(byCreatedAt);
  return ok({ baseCurrency: fx.base, assets: sortedAssets.map((a) => withValue(a, fx, today)) } satisfies ListAssetsResponse);
}

export async function createAsset(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const input = validate(createCustomAssetSchema.safeParse(parseJsonBody(ctx.body, ctx.isBase64Encoded)), 'Invalid asset');
  const { mgmt, now, uuid } = ctx.deps;
  if ((await mgmt.listCustomAssets(ctx.userId, portfolioId)).length >= MAX_CUSTOM_ASSETS) {
    throw new HttpError(422, 'UNPROCESSABLE', `A portfolio can have at most ${MAX_CUSTOM_ASSETS} custom assets`);
  }
  const ts = now().toISOString();
  const asset: CustomAsset = {
    assetId: uuid().toLowerCase(),
    userId: ctx.userId,
    portfolioId,
    name: input.name,
    assetClass: input.assetClass,
    currency: input.currency,
    costBasis: input.costBasis ?? input.value,
    ...(typeof input.growthRate === 'number' ? { growthRate: input.growthRate } : {}),
    valuations: [{ date: input.date ?? isoDay(now()), value: input.value }],
    createdAt: ts,
    updatedAt: ts,
  };
  await mgmt.putCustomAsset(asset);
  return respond(ctx, asset, 201);
}

export async function updateAsset(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const { growthRate, ...fields } = validate(updateCustomAssetSchema.safeParse(parseJsonBody(ctx.body, ctx.isBase64Encoded)), 'Invalid asset');
  const { growthRate: previous, ...current } = await requireAsset(ctx, portfolioId);
  // `growthRate: null` removes the rate, an absent field keeps it.
  const nextGrowth = growthRate === undefined ? previous : (growthRate ?? undefined);
  const next: CustomAsset = {
    ...current,
    ...fields,
    ...(nextGrowth === undefined ? {} : { growthRate: nextGrowth }),
    updatedAt: ctx.deps.now().toISOString(),
  };
  await ctx.deps.mgmt.putCustomAsset(next);
  return respond(ctx, next);
}

export async function deleteAsset(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const asset = await requireAsset(ctx, portfolioId);
  await ctx.deps.mgmt.deleteCustomAsset(ctx.userId, portfolioId, asset.assetId);
  return ok(undefined, 204);
}

/** Adds or replaces the valuation point of a date. */
export async function putValuation(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const point = validate(valuationSchema.safeParse(parseJsonBody(ctx.body, ctx.isBase64Encoded)), 'Invalid valuation');
  const asset = await requireAsset(ctx, portfolioId);
  const next = upsertValuation(asset, point);
  if (!next) throw new HttpError(422, 'UNPROCESSABLE', 'Too many valuation points');
  const saved = { ...next, updatedAt: ctx.deps.now().toISOString() };
  await ctx.deps.mgmt.putCustomAsset(saved);
  return respond(ctx, saved);
}

export async function deleteValuation(ctx: RouteContext): Promise<RouteResult> {
  const portfolioId = await requirePathPortfolio(ctx);
  const date = validate(isoDateSchema.safeParse(ctx.pathParams.date), 'Invalid date');
  const asset = await requireAsset(ctx, portfolioId);
  if (!asset.valuations.some((v) => v.date === date)) throw new HttpError(404, 'NOT_FOUND', `No valuation on ${date}`);
  if (asset.valuations.length === 1) throw new PortfolioError('An asset needs at least one valuation');
  const next = { ...asset, valuations: asset.valuations.filter((v) => v.date !== date), updatedAt: ctx.deps.now().toISOString() };
  await ctx.deps.mgmt.putCustomAsset(next);
  return respond(ctx, next);
}
