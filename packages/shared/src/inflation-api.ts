/**
 * Inflation REST contract: the euro-area (or Dutch) HICP annual rate of change, monthly, from the ECB Data Portal. The server
 * fetches and caches it (the browser never calls the ECB); the goal forms average it into an "inflation per year" suggestion.
 *
 * - GET /inflation?area=U2|NL   the monthly series since January 1999 (area defaults to U2 = euro area)
 *
 * Errors use the standard envelope: 400 VALIDATION_ERROR (unknown area), 502 INFLATION_UNAVAILABLE (the ECB cannot be reached and
 * nothing is cached yet), 503 INFLATION_NOT_CONFIGURED (a deployment without the feature). Rates are percentages (2.5 = 2.5 %).
 */
import { z } from 'zod';

export const INFLATION_ROUTES = {
  inflationGet: 'GET /inflation',
} as const;

export const INFLATION_AREAS = ['U2', 'NL'] as const;
export type InflationArea = (typeof INFLATION_AREAS)[number];
export const INFLATION_AREA_LABELS: Record<InflationArea, string> = { U2: 'Euro area', NL: 'Netherlands' };
export const DEFAULT_INFLATION_AREA: InflationArea = 'U2';

export const inflationQuerySchema = z.object({ area: z.enum(INFLATION_AREAS).default(DEFAULT_INFLATION_AREA) });

/** ECB Data Portal dataflow and the series key per area: FREQ.REF_AREA.ADJUSTMENT.ICP_ITEM.DATA_PROVIDER.ICP_SUFFIX (HICP, overall index, annual rate of change). */
export const ECB_INFLATION_FLOW = 'HICP';
export const ecbInflationSeriesKey = (area: InflationArea): string => `M.${area}.N.000000.4D0.ANR`;
/** The series is requested from this month on (the euro exists since January 1999). */
export const INFLATION_START_MONTH = '1999-01';

/** One month of the series: `month` is `YYYY-MM`, `ratePct` the change of the price index against the same month a year earlier. */
export interface InflationPoint {
  month: string;
  ratePct: number;
}

export interface InflationResponse {
  area: InflationArea;
  /** The ECB series that was read, e.g. `HICP.M.U2.N.000000.4D0.ANR`. */
  series: string;
  /** Oldest first, one point per month. */
  points: InflationPoint[];
  /** Month of the last point, `YYYY-MM`. */
  latestMonth: string;
  /** When the series was fetched from the ECB (ISO timestamp). */
  fetchedAt: string;
  /** True when the ECB could not be reached and the series comes from an older fetch. */
  stale: boolean;
}

// --- Cached series (single-table item: PK REF#INFLATION, SK AREA#{area}) ----------------------------------------------

export const INFLATION_ENTITY = 'INFLATION';

export const inflationKeys = {
  series: (area: InflationArea) => ({ PK: 'REF#INFLATION', SK: `AREA#${area}` }),
} as const;

/** Stored series: the response without `stale`, plus when the ECB was last asked (also after a failed attempt). */
export interface InflationItem {
  area: InflationArea;
  series: string;
  points: InflationPoint[];
  latestMonth: string;
  fetchedAt: string;
  attemptedAt: string;
}
