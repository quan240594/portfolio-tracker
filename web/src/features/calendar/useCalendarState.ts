import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { applyCalendarState, localToday, parseCalendarState, type CalendarUiState, type CalendarView } from './calendarModel';

/** The grid needs room: below this width the list is the default view. */
const GRID_MIN_WIDTH = '(min-width: 640px)';

const defaultViewOf = (): CalendarView => (globalThis.matchMedia?.(GRID_MIN_WIDTH).matches ? 'calendar' : 'list');

/** View, month, range and filters of the calendar page live in the URL, so links and the back button work. */
export function useCalendarState() {
  const [params, setParams] = useSearchParams();
  const today = useMemo(() => localToday(), []);
  const defaultView = useMemo(defaultViewOf, []);
  const state = useMemo(() => parseCalendarState(params, today, defaultView), [params, today, defaultView]);

  const update = useCallback(
    (patch: Partial<CalendarUiState>) =>
      setParams((current) => applyCalendarState(current, { ...parseCalendarState(current, today, defaultView), ...patch }, today, defaultView), { replace: true }),
    [setParams, today, defaultView],
  );
  return { state, update, today };
}
