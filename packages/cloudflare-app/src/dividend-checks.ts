/**
 * The Cloudflare side of the Diagnostics "Dividend dates" section (`Deps.dividendChecks`): how much of the EODHD allowance of the day is used and the
 * "Check dividends now" button, which queues a dividends-only `refreshCalendar` run once an hour. No business logic: which symbols are read, in which
 * order and how the outcome is recorded live in `@portfolio/prices`, the report in `@portfolio/shared` and the API route.
 */
import { JOBS, nextUtcMidnight, utcDay, type ItemStore, type JobQueue } from '@portfolio/platform';
import type { DividendChecksDeps } from '@portfolio/api';
import { PriceRepository, type PricesConfig } from '@portfolio/prices';
import { MIN_EODHD_CALLS_FOR_CHECK, REFRESH_INTERVAL_SECONDS, type DividendBudgetReport, type RefreshReport } from '@portfolio/shared';

/** When the owner last asked for a check (one item; a second ask within the hour is refused). */
export const DIVIDEND_ASK_KEY = { PK: 'CALENDAR', SK: 'DIVIDENDS#REFRESHASK' } as const;
const DIVIDEND_ASK_ENTITY = 'DIVIDEND_REFRESH_ASK';

export interface DividendChecksContext {
  items: ItemStore;
  config: PricesConfig;
  queue: JobQueue;
  now: () => Date;
}

type Refusal = Extract<Awaited<ReturnType<DividendChecksDeps['refresh']>>, { accepted: false }>;

interface State {
  budget: DividendBudgetReport | null;
  refresh: RefreshReport;
  refusal: Refusal | null;
}

const clock = (iso: string): string => iso.slice(11, 16);

/** The Cloudflare adapter of the dividend dates diagnostics. */
export function createDividendChecksApi({ items, config, queue, now }: Readonly<DividendChecksContext>): DividendChecksDeps {
  const prices = new PriceRepository(items);

  async function state(): Promise<State> {
    const at = now();
    const day = utcDay(at);
    const limit = config.dailyLimits.eodhd;
    const { used, calendarUsed } = await prices.callsUsedOn('eodhd', day);
    const budget: DividendBudgetReport = { provider: 'EODHD', day, used, limit, remaining: Math.max(0, limit - used), calendarUsed, calendarLimit: config.calendar.eodhdDailyCalls };
    const unavailable = (refusal: Refusal, nextAllowedAt: string | null): State => ({ budget, refresh: { available: false, reason: refusal.message, nextAllowedAt }, refusal });
    if (config.keys.eodhd === undefined) {
      return unavailable({ accepted: false, reason: 'not-configured', message: 'No EODHD key is set on this deployment (the EODHD_API_KEY secret), so there is no dividend source to check.' }, null);
    }
    const asked = (await items.get(DIVIDEND_ASK_KEY))?.askedAt;
    const waitMs = typeof asked === 'string' ? Date.parse(asked) + REFRESH_INTERVAL_SECONDS * 1000 - at.getTime() : 0;
    if (waitMs > 0) {
      const retryAt = new Date(at.getTime() + waitMs).toISOString();
      return unavailable({ accepted: false, reason: 'rate-limited', message: `Dividends were checked on request at ${clock(String(asked))} UTC; you can ask again after ${clock(retryAt)} UTC (once an hour).`, retryAfterSeconds: Math.ceil(waitMs / 1000) }, retryAt);
    }
    if (budget.remaining < MIN_EODHD_CALLS_FOR_CHECK) {
      const resets = nextUtcMidnight(at);
      const message = `EODHD allowance spent: ${used} of ${limit} calls today (UTC), and a check needs a few. It resets at 00:00 UTC; the daily run is at 05:30 Amsterdam time.`;
      return unavailable({ accepted: false, reason: 'budget-low', message, retryAfterSeconds: Math.ceil((resets.getTime() - at.getTime()) / 1000) }, resets.toISOString());
    }
    return { budget, refresh: { available: true, reason: null, nextAllowedAt: null }, refusal: null };
  }

  return {
    async status() {
      const { budget, refresh } = await state();
      return { budget, refresh, configured: { eodhd: config.keys.eodhd !== undefined, alphavantage: config.keys.alphavantage !== undefined } };
    },
    async refresh() {
      const current = await state();
      if (current.refusal) return current.refusal;
      await items.put({ ...DIVIDEND_ASK_KEY, entityType: DIVIDEND_ASK_ENTITY, askedAt: now().toISOString() });
      await queue.enqueue({ job: JOBS.refreshCalendar, payload: { trigger: 'manual', part: 'dividends' } });
      return { accepted: true };
    },
  };
}
