import {
  JOB_CEILINGS,
  JOBS,
  QueueEventPublisher,
  guardJob,
  logger,
  SCHEDULED_JOBS,
  secondsUntilReset,
  type BudgetGuard,
  type EventPublisher,
  type FileStore,
  type ItemStore,
  type JobHandler,
  type JobName,
  type JobPayloads,
  type JobQueue,
  type JobRegistry,
  type JobStep,
  type ScheduledJob,
  type SecretStore,
} from '@portfolio/platform';
import { ItemBrokerStore, ItemProfileStore, ItemQuoteStore, SecretCredentialStore, Trading212Client, brokerSyncJob, refreshQuotesAfterSync, refreshQuotesJob, type QuoteDeps, type SyncDeps } from '@portfolio/broker-sync';
import { ItemIngestStore, importUploadedJob } from '@portfolio/ingest';
import { DEFAULT_STEP_SUBREQUESTS, PRICE_SCHEDULES, createPriceJobs, type PriceJobDeps } from '@portfolio/prices';
import type { HubConfig } from './config.js';
import { SubrequestBudget } from './subrequests.js';

/** Everything a job handler may need, built by the Hub for one alarm run. */
export interface JobContext {
  items: ItemStore;
  secrets: SecretStore;
  files: FileStore;
  /** Enqueues jobs on the Hub's alarm queue. */
  queue: JobQueue;
  /** Publishes `transactionsChanged`; a no-op until a price service is registered (see `PRICE_JOB_FACTORIES`). */
  events: EventPublisher;
  now: () => Date;
  config: HubConfig;
  /** Subrequests (outbound `fetch` calls) left in this invocation: 50 on the free plan. */
  budget: SubrequestBudget;
  /** The global `fetch`, counted by `budget`. Every outbound call a job makes must go through it. */
  fetch: typeof fetch;
  /** Pauses (`setTimeout`); the price service's HTTP client backs off with it, never for long. */
  sleep: (ms: number) => Promise<void>;
}

export type JobFactory<N extends JobName> = (context: JobContext) => JobHandler<JobPayloads[N]>;
export type JobFactories = { [N in JobName]?: JobFactory<N> };

/** Subrequests one Trading 212 sync step can use: `T212_PAGES_PER_STEP` pages, each retried up to `T212_MAX_ATTEMPTS` times, plus the exchange list. */
export const T212_PAGES_PER_STEP = 5;
export const T212_MAX_ATTEMPTS = 3;
/** The quote refresh makes one positions request, plus the two metadata requests when an instrument cannot be mapped or a held symbol has no asset class yet (hourly at most). */
export const T212_QUOTE_SUBREQUESTS = 3;
const T212_QUOTE_TIMEOUT_MS = 15_000;

const noEvents: EventPublisher = { transactionsChanged: () => Promise.resolve() };

/** Jobs that run on the Hub today: the CSV import, the Trading 212 sync and its quote refresh (all platform-neutral, from `services/*`). */
export const CORE_JOB_FACTORIES: JobFactories = {
  importUploaded: ({ items, files, events, now }) => importUploadedJob({ store: new ItemIngestStore(items), files, events, now }),
  syncBroker: (context) => {
    const { items, secrets, events, now, config, fetch } = context;
    const deps: SyncDeps = {
      store: new ItemBrokerStore(items),
      events,
      credentials: new SecretCredentialStore(secrets, config.brokerSecretPrefix),
      createApi: (credentials) => new Trading212Client({ credentials, fetchFn: fetch, maxAttempts: T212_MAX_ATTEMPTS }),
      symbolOverrides: config.symbolOverrides,
      now,
      limits: { pagesPerStep: T212_PAGES_PER_STEP },
    };
    // A successful sync prices its positions right away: the quote refresh is enqueued as a job of its own.
    return refreshQuotesAfterSync(brokerSyncJob(() => deps), context.queue);
  },
  refreshT212Quotes: ({ items, secrets, now, config, fetch }) => {
    const deps: QuoteDeps = {
      store: new ItemBrokerStore(items),
      quotes: new ItemQuoteStore(items),
      // The same run writes the baseline profiles (name, type, ISIN) of the held symbols: no extra request, see docs/architecture.md.
      profiles: new ItemProfileStore(items),
      credentials: new SecretCredentialStore(secrets, config.brokerSecretPrefix),
      // One attempt and no waiting: a limit or an error is recorded and backed off by the job; the alarm must never sleep for it.
      createApi: (credentials) => new Trading212Client({ credentials, fetchFn: fetch, maxAttempts: 1, timeoutMs: T212_QUOTE_TIMEOUT_MS, maxWaitMs: 0 }),
      symbolOverrides: config.symbolOverrides,
      now,
    };
    return refreshQuotesJob(() => deps);
  },
};

/** What the price jobs need, built from the Hub's ports (`@portfolio/prices`' `PriceJobDeps`). */
export function priceJobDeps({ items, fetch, now, sleep, config, queue }: JobContext): PriceJobDeps {
  // Every fetch of a price step goes through the alarm's counted `fetch`; the service's own per-step budget (40) sits below it.
  return {
    store: items,
    fetch,
    clock: now,
    sleep,
    config: config.prices,
    logger,
    // The scheduled refresh starts the enrichment of tracked symbols that never had one (once a day).
    enqueueEnrichment: (symbols) => queue.enqueue({ job: JOBS.enrichTransactions, payload: { userId: '', portfolioId: '', reason: 'IMPORTED', symbols: [...symbols] } }),
  };
}

/**
 * The price service: `refreshPrices` (the scheduled quote, FX and profile refresh), `enrichTransactions` (history, dividends and
 * profile of newly tracked symbols) and `refreshCalendar` (earnings, splits, dividend re-checks) from `@portfolio/prices`. Each
 * is resumable (a step makes at most 40 fetches, retries included) and runs behind `guardJob`, so the two refreshes only run
 * below 60 % of the free-plan budget and enrichment below 80 %. Provider keys are optional Worker secrets: a missing key
 * switches that source off (its symbols are reported as skipped) and never fails a job.
 */
export const PRICE_JOB_FACTORIES: JobFactories = {
  refreshPrices: (context) => createPriceJobs(priceJobDeps(context)).refreshPrices!,
  enrichTransactions: (context) => createPriceJobs(priceJobDeps(context)).enrichTransactions!,
  refreshCalendar: (context) => createPriceJobs(priceJobDeps(context)).refreshCalendar!,
};

/** Subrequests a step of the job needs left; the alarm defers the step to a fresh invocation when fewer remain. */
export const JOB_SUBREQUEST_RESERVE: Readonly<Partial<Record<JobName, number>>> = {
  syncBroker: T212_PAGES_PER_STEP * T212_MAX_ATTEMPTS + 3,
  // A price step may use DEFAULT_STEP_SUBREQUESTS (40) of the 45 an alarm plans for, so one price step fits per alarm.
  refreshPrices: DEFAULT_STEP_SUBREQUESTS,
  enrichTransactions: DEFAULT_STEP_SUBREQUESTS,
  refreshCalendar: DEFAULT_STEP_SUBREQUESTS,
  refreshT212Quotes: T212_QUOTE_SUBREQUESTS,
};

export const ALL_JOB_FACTORIES: JobFactories = { ...CORE_JOB_FACTORIES, ...PRICE_JOB_FACTORIES };

/** The jobs that have a handler: schedules of other jobs are not kept (they would only fail and retry). */
export const registeredJobs = (factories: JobFactories = ALL_JOB_FACTORIES): JobName[] => Object.keys(factories) as JobName[];

/** The schedules the Hub keeps: those of the registered jobs (the price schedules among them once the price service is registered). */
export const schedulesFor = (factories: JobFactories = ALL_JOB_FACTORIES): ScheduledJob[] => {
  const known = new Set<string>(registeredJobs(factories));
  return SCHEDULED_JOBS.filter((schedule) => known.has(schedule.job));
};

/** The price service's own schedules (`prices-refresh`, `prices-calendar`), for the status report. */
export const PRICE_SCHEDULE_NAMES: readonly string[] = PRICE_SCHEDULES.map((schedule) => schedule.name);

/** True when `enrichTransactions` has a handler, i.e. a price service is registered. */
export const hasPriceService = (factories: JobFactories = ALL_JOB_FACTORIES): boolean => factories.enrichTransactions !== undefined;

/** The `EventPublisher` of the Hub: events become jobs once there is a consumer for them. */
export const eventsFor = (queue: JobQueue, factories: JobFactories = ALL_JOB_FACTORIES): EventPublisher =>
  hasPriceService(factories) ? new QueueEventPublisher(queue) : noEvents;

/**
 * Jobs that are dropped, not deferred, when the guard denies them: the non-essential ones (`ok` ceiling) and the Trading 212 quote
 * refresh. Its next scheduled slot comes within 15 minutes, so a deferral would only pile up hourly retries behind it.
 */
const dropsWhenDenied = (name: JobName): boolean => JOB_CEILINGS[name] === 'ok' || name === 'refreshT212Quotes';

/** A deferred job that has not started yet has no cursor of its own, but a step must return a string. */
export const DEFERRED_CURSOR = 'deferred:not-started';

const SUBREQUEST_DEFER_MS = 1_000;
const UNAVAILABLE_DEFER_MS = 5 * 60_000;
const BLOCKED_DEFER_MAX_MS = 60 * 60_000;
const RESET_MARGIN_MS = 60_000;

export interface GuardOptions {
  guard: BudgetGuard;
  budget: SubrequestBudget;
  now: () => Date;
}

/**
 * Gates a job handler behind the budget guard. A denied job that is non-essential (the price and calendar refreshes, whose
 * next schedule retries them anyway) completes as `skipped`; an essential one (import, sync) is deferred: the same cursor
 * comes back after a pause (until the daily reset at the latest, re-checked hourly). A step that needs more subrequests
 * than are left in this invocation is deferred by a second, so the alarm that runs it again starts with a fresh budget.
 */
export function guardedJob<N extends JobName>(name: N, handler: JobHandler<JobPayloads[N]>, options: GuardOptions): JobHandler<JobPayloads[N]> {
  const { guard, budget, now } = options;
  const reserve = JOB_SUBREQUEST_RESERVE[name] ?? 0;
  const defer = (delayMs: number, cursor: string | undefined): JobStep => ({ done: false, next: cursor ?? DEFERRED_CURSOR, delayMs });
  return async ({ payload, cursor }) => {
    const resume = cursor === DEFERRED_CURSOR ? undefined : cursor;
    const decision = await guardJob(guard, name);
    if (!decision.allowed) {
      logger.info('Job not run', { job: name, reason: decision.reason });
      if (dropsWhenDenied(name)) return { done: true, result: { skipped: decision.reason } };
      const pause = decision.reason === 'store-unavailable' ? UNAVAILABLE_DEFER_MS : Math.min(secondsUntilReset(now()) * 1000 + RESET_MARGIN_MS, BLOCKED_DEFER_MAX_MS);
      return defer(pause, resume);
    }
    if (budget.remaining() < reserve) return defer(SUBREQUEST_DEFER_MS, resume);
    return handler({ payload, cursor: resume });
  };
}

/** Handlers of every registered job, each behind `guardedJob`, over the Hub's ports. */
export function createJobRegistry(context: JobContext, options: Omit<GuardOptions, 'budget' | 'now'>, factories: JobFactories = ALL_JOB_FACTORIES): JobRegistry {
  const guardOptions: GuardOptions = { ...options, budget: context.budget, now: context.now };
  const registry: JobRegistry = {};
  for (const name of registeredJobs(factories)) {
    const factory = factories[name] as JobFactory<typeof name>;
    (registry as Record<string, JobHandler<never>>)[name] = guardedJob(name, factory(context), guardOptions) as JobHandler<never>;
  }
  return registry;
}
