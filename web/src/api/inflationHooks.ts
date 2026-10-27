import { useQuery } from '@tanstack/react-query';
import type { InflationArea, InflationResponse } from '@portfolio/shared';
import { request } from './client';

/** The ECB publishes once a month and the server caches the series for a month: asking again within hours changes nothing. */
export const INFLATION_STALE_MS = 6 * 3_600_000;

export const inflationKey = (area: InflationArea) => ['inflation', area] as const;

export const inflationApi = {
  get: (area: InflationArea, signal?: AbortSignal) => request<InflationResponse>('GET', '/inflation', { query: { area }, signal }),
};

/** The monthly ECB inflation series of an area; idle while `enabled` is false (nothing is fetched until the forecast is chosen). */
export const useInflation = (area: InflationArea, { enabled = true }: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: inflationKey(area), queryFn: ({ signal }) => inflationApi.get(area, signal), enabled, staleTime: INFLATION_STALE_MS });
