/**
 * Demo calendar data relative to "today": upcoming earnings dates, one upcoming split, an irregular share adjustment and
 * declared dividends of watchlist symbols. The held symbols' dividends come from the existing dividend events; the shared
 * `buildCalendar` adds the received, declared and estimated ones, exactly as the API does with DynamoDB items.
 */
import {
  calendarAddMonths,
  calendarLastDay,
  calendarMonthOf,
  type DividendEvent,
  type StoredEarningsEvent,
  type StoredSplitEvent,
} from '@portfolio/shared';
import { addDays } from './fixtures';

export interface CalendarSeed {
  earnings: StoredEarningsEvent[];
  splits: StoredSplitEvent[];
  /** Declared dividends of watchlist symbols (the held ones are in the main dividend seed). */
  dividendEvents: DividendEvent[];
}

const isWeekend = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
function nextWeekday(date: string): string {
  let d = date;
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}

interface EarningsPlan {
  symbol: string;
  name: string;
  daysAhead: number;
  eps: number;
  timeOfDay: 'BMO' | 'AMC';
}

/** Days ahead of the cluster of events shared by several symbols. */
const BUSY_DAY = 15;

const PLANS: EarningsPlan[] = [
  { symbol: 'KO', name: 'COCA COLA CO', daysAhead: 7, eps: 0.77, timeOfDay: 'BMO' },
  { symbol: 'AAPL', name: 'APPLE INC', daysAhead: 13, eps: 1.64, timeOfDay: 'AMC' },
  { symbol: 'MSFT', name: 'MICROSOFT CORP', daysAhead: 20, eps: 3.12, timeOfDay: 'AMC' },
  { symbol: 'JNJ', name: 'JOHNSON & JOHNSON', daysAhead: 26, eps: 2.58, timeOfDay: 'BMO' },
  // The same day as KO's and NVDA's ex-dividend dates: a busy day that shows the "+N more" overflow.
  { symbol: 'NVDA', name: 'NVIDIA CORP', daysAhead: BUSY_DAY, eps: 0.74, timeOfDay: 'AMC' },
];

/** The quarter that ended before the report. */
const fiscalPeriodEnd = (reportDate: string): string => calendarLastDay(calendarAddMonths(calendarMonthOf(reportDate), -1));

export function createCalendarSeed(today: string): CalendarSeed {
  const upcoming = PLANS.map<StoredEarningsEvent>((p) => {
    const date = p.daysAhead === BUSY_DAY ? addDays(today, BUSY_DAY) : nextWeekday(addDays(today, p.daysAhead));
    return { symbol: p.symbol, name: p.name, date, fiscalPeriodEnd: fiscalPeriodEnd(date), epsEstimate: p.eps, currency: 'USD', timeOfDay: p.timeOfDay, source: 'alphavantage' };
  });
  // Last quarter's reports, to browse back in time.
  const previous = PLANS.filter((p) => ['AAPL', 'MSFT', 'KO'].includes(p.symbol)).map<StoredEarningsEvent>((p) => {
    const date = nextWeekday(addDays(today, p.daysAhead - 91));
    return { symbol: p.symbol, name: p.name, date, fiscalPeriodEnd: fiscalPeriodEnd(date), epsEstimate: p.eps - 0.05, currency: 'USD', timeOfDay: p.timeOfDay, source: 'alphavantage' };
  });
  return {
    earnings: [...previous, ...upcoming],
    splits: [
      { symbol: 'MSFT', date: addDays(today, BUSY_DAY), fromFactor: 1, toFactor: 2, source: 'eodhd' },
      { symbol: 'NVDA', date: nextWeekday(addDays(today, 52)), fromFactor: 100, toFactor: 104, source: 'eodhd' },
    ],
    dividendEvents: [
      { symbol: 'SAP.DE', exDate: nextWeekday(addDays(today, 12)), payDate: nextWeekday(addDays(today, 30)), amount: 2.35, currency: 'EUR' },
      { symbol: 'NVDA', exDate: addDays(today, BUSY_DAY), payDate: nextWeekday(addDays(today, 37)), amount: 0.01, currency: 'USD' },
    ],
  };
}
