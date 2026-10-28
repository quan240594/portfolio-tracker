/**
 * The Cloudflare side of the Diagnostics "Earnings dates" section (`Deps.calendarDates`): how much of the Alpha Vantage allowance of the day is
 * used and the "Refresh earnings dates now" button, which queues the `refreshCalendar` job once. No business logic: the dates, the reasons and
 * the report live in `@portfolio/shared` and the API route, the fetch in `@portfolio/prices`.
 */
import { JOBS, nextUtcMidnight, utcDay, type ItemStore, type JobQueue } from '@portfolio/platform';
import type { CalendarDatesDeps } from '@portfolio/api';
import { PriceRepository, type PricesConfig } from '@portfolio/prices';
import { MIN_CALLS_FOR_REFRESH, REFRESH_INTERVAL_SECONDS, type ProviderBudgetReport, type RefreshReport } from '@portfolio/shared';

/** When the owner last asked for a refresh (one item; a second ask within the hour is refused). */
export const REFRESH_ASK_KEY = { PK: 'CALENDAR', SK: 'EARNINGS#REFRESHASK' } as const;
const REFRESH_ASK_ENTITY = 'EARNINGS_REFRESH_ASK';

export interface CalendarDatesContext {
  items: ItemStore;
  config: PricesConfig;
  queue: JobQueue;
  now: () => Date;
}

type Refusal = Extract<Awaited<ReturnType<CalendarDatesDeps['refresh']>>, { accepted: false }>;

interface State {
  budget: ProviderBudgetReport | null;
  refresh: RefreshReport;
  /** Set when the refresh is not available: what to tell the caller. */
  refusal: Refusal | null;
}

const clock = (iso: string): string => iso.slice(11, 16);

/** The Cloudflare adapter of the earnings dates diagnostics. */
export function createCalendarDatesApi({ items, config, queue, now }: Readonly<CalendarDatesContext>): CalendarDatesDeps {
  const prices = new PriceRepository(items);

  async function state(): Promise<State> {
    const at = now();
    const day = utcDay(at);
    const limit = config.dailyLimits.alphavantage;
    const { used, calendarUsed } = await prices.callsUsedOn('alphavantage', day);
    const budget: ProviderBudgetReport = { provider: 'Alpha Vantage', day, used, limit, remaining: Math.max(0, limit - used), calendarUsed, calendarLimit: config.calendar.alphavantageDailyCalls };
    const unavailable = (refusal: Refusal, nextAllowedAt: string | null): State => ({ budget, refresh: { available: false, reason: refusal.message, nextAllowedAt }, refusal });
    if (config.keys.alphavantage === undefined) {
      return unavailable({ accepted: false, reason: 'not-configured', message: 'No Alpha Vantage key is set on this deployment (the ALPHAVANTAGE_API_KEY secret), so there is nothing to refresh.' }, null);
    }
    const asked = (await items.get(REFRESH_ASK_KEY))?.askedAt;
    const waitMs = typeof asked === 'string' ? Date.parse(asked) + REFRESH_INTERVAL_SECONDS * 1000 - at.getTime() : 0;
    if (waitMs > 0) {
      const retryAt = new Date(at.getTime() + waitMs).toISOString();
      return unavailable({ accepted: false, reason: 'rate-limited', message: `Earnings dates were refreshed on request at ${clock(String(asked))} UTC; you can ask again after ${clock(retryAt)} UTC (once an hour).`, retryAfterSeconds: Math.ceil(waitMs / 1000) }, retryAt);
    }
    if (budget.remaining < MIN_CALLS_FOR_REFRESH) {
      const resets = nextUtcMidnight(at);
      const message = `Alpha Vantage allowance nearly used: ${used} of ${limit} calls today (UTC). It resets at 00:00 UTC; the next daily run is at 05:30 Amsterdam time.`;
      return unavailable({ accepted: false, reason: 'budget-low', message, retryAfterSeconds: Math.ceil((resets.getTime() - at.getTime()) / 1000) }, resets.toISOString());
    }
    return { budget, refresh: { available: true, reason: null, nextAllowedAt: null }, refusal: null };
  }

  return {
    async status() {
      const { budget, refresh } = await state();
      return { budget, refresh };
    },
    async refresh() {
      const current = await state();
      if (current.refusal) return current.refusal;
      await items.put({ ...REFRESH_ASK_KEY, entityType: REFRESH_ASK_ENTITY, askedAt: now().toISOString() });
      await queue.enqueue({ job: JOBS.refreshCalendar, payload: { trigger: 'manual' } });
      return { accepted: true };
    },
  };
}
