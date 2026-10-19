import { JOBS, runToCompletion, SCHEDULED_JOBS, type EnrichmentSummary, type FxBackfillSummary, type JobHandler, type JobRegistry, type MarketDataService, type CalendarRefreshSummary, type ScheduledRefreshSummary } from '@portfolio/platform';
import { createEnrichTransactionsJob } from './jobs/enrich.js';
import { createRefreshCalendarJob } from './jobs/refresh-calendar.js';
import { createRefreshPricesJob } from './jobs/refresh-prices.js';
import type { PriceJobDeps } from './jobs/common.js';
import { createMarketData } from './market.js';
import { PriceRepository } from './repository.js';
import { byText } from './parse.js';
import { addDays } from './time.js';

/** The jobs this package implements, by `JOBS` name. */
export const PRICE_JOB_NAMES = [JOBS.refreshPrices, JOBS.enrichTransactions, JOBS.refreshCalendar] as const;

/** Handlers for a `JobRegistry`; the adapter runs them step by step (Durable Object alarm) or to completion (Lambda). */
export function createPriceJobs(deps: PriceJobDeps): Pick<JobRegistry, (typeof PRICE_JOB_NAMES)[number]> {
  return {
    refreshPrices: createRefreshPricesJob(deps),
    enrichTransactions: createEnrichTransactionsJob(deps),
    refreshCalendar: createRefreshCalendarJob(deps),
  };
}

/** The entries of `SCHEDULED_JOBS` that fire these jobs (`prices-refresh`, `prices-calendar`). */
export const PRICE_SCHEDULES = SCHEDULED_JOBS.filter((entry) => (PRICE_JOB_NAMES as readonly string[]).includes(entry.job));

/** Runs a job's steps back to back on a clock that advances with the pauses the job asks for. */
function runWhole<P, R>(deps: PriceJobDeps, now: Date, create: (deps: PriceJobDeps) => JobHandler<P, R>, payload: P): Promise<R> {
  let current = now.getTime();
  const sleep = async (ms: number): Promise<void> => {
    current += ms;
    await deps.sleep(ms);
  };
  return runToCompletion(create({ ...deps, clock: () => new Date(current), sleep }), payload, { sleep });
}

/**
 * `MarketDataService` of the platform: the same jobs run to completion inside the call (CLI, Lambda, tests). Budgeted hosts
 * use `createPriceJobs` and persist the cursor between steps instead.
 */
export function createMarketDataService(deps: PriceJobDeps): MarketDataService {
  return {
    refreshScheduled: (now): Promise<ScheduledRefreshSummary> => runWhole(deps, now, createRefreshPricesJob, { trigger: 'scheduled' }),
    enrichSymbols: (event, now): Promise<EnrichmentSummary> => runWhole(deps, now, createEnrichTransactionsJob, { userId: '', portfolioId: '', reason: 'CREATED', ...event }),
    refreshCalendar: (now): Promise<CalendarRefreshSummary> => runWhole(deps, now, createRefreshCalendarJob, { trigger: 'scheduled' }),
    backfillFxHistory: (today, start): Promise<FxBackfillSummary> => backfillFxHistory(deps, today, start),
  };
}

/** Stores the ECB daily fixings from `start` (default: the day after the newest stored one) through `today`. Errors propagate. */
export async function backfillFxHistory(deps: PriceJobDeps, today: string, start?: string): Promise<FxBackfillSummary> {
  const { fx } = (deps.marketData ?? createMarketData)(deps, deps.fetch);
  const repo = new PriceRepository(deps.store);
  const base = deps.config.baseCurrency;
  const stored = await repo.latestFxDay(base);
  const from = start ?? (stored === null ? deps.config.fxHistoryStart : addDays(stored, 1));
  const days = from <= today ? await fx.getHistory(base, from, today) : [];
  const written = days.length > 0 ? await repo.putFxDays(days) : 0;
  const newest = days.at(-1)?.date ?? null;
  const lastDay = [stored, newest].filter((day): day is string => day !== null).toSorted(byText).at(-1) ?? null;
  return { base, start: from, end: today, fxDaysWritten: written, lastDay };
}
