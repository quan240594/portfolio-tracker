import { inflationQuerySchema, type INFLATION_ROUTES } from '@portfolio/shared';
import { HttpError, ok, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { InflationService, InflationUnavailableError } from '../inflation/service.js';
import { EcbInflationSource } from '../inflation/source.js';
import type { RouteHandler } from '../router.js';

/** The monthly ECB inflation series (cached in the item store, see docs/architecture.md "Goal assumption helpers"). */
export async function getInflation(ctx: RouteContext): Promise<RouteResult> {
  const { inflation, now } = ctx.deps;
  if (!inflation) throw new HttpError(503, 'INFLATION_NOT_CONFIGURED', 'The inflation data is not available in this deployment');
  const { area } = validate(inflationQuerySchema.safeParse(ctx.query), 'Invalid inflation query');
  const service = new InflationService({ store: inflation.items, source: new EcbInflationSource({ fetch: inflation.fetch }), now });
  try {
    return ok(await service.get(area));
  } catch (error) {
    if (error instanceof InflationUnavailableError) throw new HttpError(502, 'INFLATION_UNAVAILABLE', error.message);
    throw error;
  }
}

export const inflationHandlers: Record<keyof typeof INFLATION_ROUTES, RouteHandler> = {
  inflationGet: getInflation,
};
