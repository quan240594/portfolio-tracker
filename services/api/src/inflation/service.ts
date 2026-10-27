/**
 * Cached inflation series: one item per area in the ItemStore, refreshed from the ECB at most once a month. The ECB publishes
 * monthly, so a month-old copy is as good as the live one: a refresh is one request and one row written per area and month.
 * When the ECB cannot be reached the cached series is served as it is (`stale: true`); only without any cache is it an error.
 */
import type { Item, ItemStore } from '@portfolio/platform';
import { INFLATION_ENTITY, inflationKeys, type InflationArea, type InflationItem, type InflationPoint, type InflationResponse } from '@portfolio/shared';
import type { InflationSource } from './source.js';

/** A cached series is used for this long before the ECB is asked again. */
export const INFLATION_TTL_MS = 30 * 24 * 3_600_000;
/** After a failed refresh the ECB is left alone for this long (the cached series keeps being served). */
export const INFLATION_RETRY_MS = 3_600_000;

/** Nothing can be served: the ECB cannot be reached and there is no cached copy. */
export class InflationUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('The ECB inflation series is not available right now', options);
    this.name = 'InflationUnavailableError';
  }
}

export interface InflationServiceOptions {
  store: ItemStore;
  source: InflationSource;
  now: () => Date;
}

const isPoint = (value: unknown): value is InflationPoint => {
  const point = value as Partial<InflationPoint> | null;
  return typeof point?.month === 'string' && typeof point.ratePct === 'number';
};

/** The stored item as an `InflationItem`, or null when it does not look like one (it is then fetched again). */
function readItem(item: Item | undefined): InflationItem | null {
  if (!item || !Array.isArray(item.points) || item.points.length === 0 || !item.points.every(isPoint)) return null;
  const { area, series, latestMonth, fetchedAt, attemptedAt } = item;
  if ([area, series, latestMonth, fetchedAt, attemptedAt].some((v) => typeof v !== 'string')) return null;
  return { area, series, latestMonth, fetchedAt, attemptedAt, points: item.points } as InflationItem;
}

const respond = (item: InflationItem, stale: boolean): InflationResponse => ({
  area: item.area,
  series: item.series,
  points: item.points,
  latestMonth: item.latestMonth,
  fetchedAt: item.fetchedAt,
  stale,
});

export class InflationService {
  constructor(private readonly options: InflationServiceOptions) {}

  async get(area: InflationArea): Promise<InflationResponse> {
    const { store, source, now } = this.options;
    const key = inflationKeys.series(area);
    const cached = readItem(await store.get(key));
    const nowMs = now().getTime();
    const expired = cached !== null && nowMs - Date.parse(cached.fetchedAt) >= INFLATION_TTL_MS;
    if (cached && (!expired || nowMs - Date.parse(cached.attemptedAt) < INFLATION_RETRY_MS)) return respond(cached, expired);
    try {
      const fetched = await source.fetchSeries(area);
      const stamp = now().toISOString();
      const item: InflationItem = { area, series: fetched.series, points: fetched.points, latestMonth: fetched.points.at(-1)!.month, fetchedAt: stamp, attemptedAt: stamp };
      await store.put({ ...key, entityType: INFLATION_ENTITY, ...item });
      return respond(item, false);
    } catch (error) {
      if (!cached) throw new InflationUnavailableError({ cause: error });
      await store.update(key, { set: { attemptedAt: now().toISOString() } });
      return respond(cached, true);
    }
  }
}
