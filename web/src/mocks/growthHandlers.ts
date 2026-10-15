import { http, type HttpHandler } from 'msw';
import {
  buildBenchmarkOptions,
  computeGrowth,
  computeHoldingsPerformance,
  growthQuerySchema,
  holdingsPerformanceQuerySchema,
  type AnalyticsData,
  type GrowthBenchmarkOption,
} from '@portfolio/shared';
import { API_BASE_URL } from '../config';
import { respond } from './analyticsHandlers';

/** Mock backend for the Growth tab: the shared calculators run on the demo fixtures, like the API runs them on DynamoDB data. */
const api = (path: string) => `${API_BASE_URL}/analytics${path}`;

/** Every demo symbol has end-of-day prices; suggestions that are not tracked are added by `buildBenchmarkOptions` (without data). */
const optionsOf = (data: AnalyticsData): GrowthBenchmarkOption[] =>
  buildBenchmarkOptions(
    Object.entries(data.eod).map(([symbol, prices]) => {
      const name = data.profiles[symbol]?.name;
      return { symbol, hasData: prices.length > 0, ...(name ? { name } : {}) };
    }),
  );

export const growthHandlers: HttpHandler[] = [
  http.get(api('/growth'), ({ request }) => respond(request, growthQuerySchema, (q, data) => computeGrowth(data, q.range, q.benchmarks, optionsOf(data)))),
  http.get(api('/holdings-performance'), ({ request }) => respond(request, holdingsPerformanceQuerySchema, (q, data) => computeHoldingsPerformance(data, q.range))),
];
