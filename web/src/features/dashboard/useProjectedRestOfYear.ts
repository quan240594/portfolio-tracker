import { useMemo } from 'react';
import { useCalendar } from '../../api/calendarHooks';
import { BASE_CURRENCY } from '../../lib/format';
import { localToday, remainingIncome } from '../calendar/calendarModel';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';

/** Declared and estimated dividends of the holdings still to be received between today and 31 December, from the calendar data. */
export function useProjectedRestOfYear() {
  const { scope, ready } = usePortfolioScope();
  const today = useMemo(() => localToday(), []);
  const yearEnd = `${today.slice(0, 4)}-12-31`;
  const params = useMemo(() => ({ from: today, to: yearEnd, status: ['CONFIRMED', 'ESTIMATED'], scope: 'holdings' }), [today, yearEnd]);
  const { data, isPending, isError } = useCalendar(scope, params, { enabled: ready });
  return {
    isPending,
    isError,
    yearEnd,
    currency: data?.baseCurrency ?? BASE_CURRENCY,
    amount: data ? remainingIncome(data.events, today, yearEnd) : undefined,
  };
}
