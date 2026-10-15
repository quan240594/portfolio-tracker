import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import type { CalendarParams } from '@portfolio/shared';
import { calendarApi } from './calendarClient';

/**
 * Calendar queries live under the `analytics` root with the scope as second segment, so `invalidatePortfolioData`
 * (see hooks.ts) refreshes them together with the other transaction-derived data.
 */
export const calendarKey = (scope: string, params: CalendarParams) => ['analytics', scope, 'calendar', params] as const;

export const useCalendar = (scope: string, params: CalendarParams, { enabled = true }: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: calendarKey(scope, params),
    queryFn: ({ signal }) => calendarApi.get(scope, params, signal),
    placeholderData: keepPreviousData,
    // Stored events change without any user action (daily refresh, watchlist edits): always show fresh data on mount.
    refetchOnMount: 'always',
    enabled,
  });

export const useDownloadCalendarIcs = (scope: string) =>
  useMutation({ mutationFn: (params: CalendarParams) => calendarApi.downloadIcs(scope, params) });
