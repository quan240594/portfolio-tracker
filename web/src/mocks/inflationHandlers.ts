import { http, HttpResponse, type HttpHandler } from 'msw';
import { ecbInflationSeriesKey, inflationQuerySchema, type InflationArea, type InflationPoint, type InflationResponse } from '@portfolio/shared';
import { api, errorResponse, latency } from './utils';

export const MOCK_INFLATION_LATEST_MONTH = '2026-09';
export const MOCK_INFLATION_FETCHED_AT = '2026-10-01T06:00:00.000Z';

const pad = (n: number): string => String(n).padStart(2, '0');

/** An invented, deterministic monthly series from January 1999 to `MOCK_INFLATION_LATEST_MONTH` (not real data; the Netherlands run 0.3 points higher). No network: the demo never calls the ECB. */
export function mockInflationPoints(area: InflationArea): InflationPoint[] {
  const points: InflationPoint[] = [];
  const [lastYear, lastMonth] = MOCK_INFLATION_LATEST_MONTH.split('-').map(Number) as [number, number];
  const months = (lastYear - 1999) * 12 + lastMonth;
  for (let index = 0; index < months; index++) {
    const year = 1999 + Math.floor(index / 12);
    const ratePct = Math.round((2 + 1.5 * Math.sin(index / 9) + (area === 'NL' ? 0.3 : 0)) * 10) / 10;
    points.push({ month: `${year}-${pad((index % 12) + 1)}`, ratePct });
  }
  return points;
}

export const inflationHandlers: HttpHandler[] = [
  http.get(api('/inflation'), async ({ request }) => {
    await latency();
    const parsed = inflationQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid query parameters', parsed.error.issues);
    const { area } = parsed.data;
    return HttpResponse.json<InflationResponse>({
      area,
      series: `ICP.${ecbInflationSeriesKey(area)}`,
      points: mockInflationPoints(area),
      latestMonth: MOCK_INFLATION_LATEST_MONTH,
      fetchedAt: MOCK_INFLATION_FETCHED_AT,
      stale: false,
    });
  }),
];
