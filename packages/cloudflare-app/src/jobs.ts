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
import { ItemNotificationRepository, ItemRepository, MAX_PUSHES_PER_USER_STEP, notifyDividendsJob } from '@portfolio/api';
import { END_OF_DAY_ZONE, ItemBrokerStore, ItemProfileStore, ItemQuoteStore, SecretCredentialStore, Trading212Client, brokerSyncJob, refreshQuotesAfterSync, refreshQuotesJob, type HandlerResult, type QuoteDeps, type SyncDeps } from '@portfolio/broker-sync';
import { ItemIngestStore, importUploadedJob } from '@portfolio/ingest';
import { DEFAULT_STEP_SUBREQUESTS, PRICE_SCHEDULES, createPriceJobs, type PriceJobDeps } from '@portfolio/prices';
import { BACKFILL_STEP_SUBREQUESTS, CHECKS_PER_STEP, createBackfillEarningsJob, createFetchEarningsSummaryJob, createWatchEarningsJob, type AiLike, type NeuronMeter } from '@portfolio/earnings';
import type { HubConfig } from './config.js';
import { earningsJobDeps } from './earnings.js';
import { pushConfig } from './push.js';
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
  /** The Workers AI binding; absent until the owner adds it (the earnings feature is then off). */
  ai?: AiLike;
  /** The Workers AI allowance of the day (the budget guard's `aiNeurons` counter). */
  neurons: NeuronMeter;
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

/**
 * Announces what a sync recorded: after a successful sync that wrote transactions, `notifyDividends` runs for that user (`trigger: 'sync'`),
 * so a booked dividend is notified within the hour. A sync that changed nothing (most of the intraday ones) enqueues nothing, and a
 * failure to enqueue never fails the sync.
 */
export function notifyAfterSync<P>(handler: JobHandler<P, HandlerResult>, queue: JobQueue): JobHandler<P, HandlerResult> {
  return async (invocation) => {
    const step = await handler(invocation);
    if (step.done) {
      const changed = step.result.results.filter((result) => result.status === 'SUCCEEDED' && !result.dryRun && (result.counts?.written ?? 0) > 0);
      const users = [...new Set(changed.map((result) => result.userId))];
      await Promise.all(
        users.map((userId) =>
          queue.enqueue({ job: JOBS.notifyDividends, payload: { trigger: 'sync', userId } }).catch(() => logger.warn('Could not enqueue the dividend notifications after a sync')),
        ),
      );
    }
    return step;
  };
}

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
    // A successful sync prices its positions right away and announces the dividends it recorded: both are jobs of their own.
    return refreshQuotesAfterSync(notifyAfterSync(brokerSyncJob(() => deps), context.queue), context.queue);
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
      // The close run keeps each quote as the end-of-day row of the day (docs/architecture.md "Price history coverage").
      endOfDay: { timeZone: END_OF_DAY_ZONE },
    };
    return refreshQuotesJob(() => deps);
  },
  // Web Push for the dividend events of the held securities. Every push goes through the alarm's counted `fetch` (one subrequest each).
  notifyDividends: ({ items, now, config, fetch }) =>
    notifyDividendsJob(() => {
      const push = pushConfig(config, fetch);
      if (!push.configured) return undefined;
      return { repo: new ItemRepository(items), notifications: new ItemNotificationRepository(items), send: push.send, baseCurrency: config.baseCurrency, now };
    }),
};

/**
 * Earnings summaries: `watchEarnings` (one SEC request per candidate symbol, queues a release it finds), `fetchEarningsSummary` (reads the
 * release with Workers AI, verifies and stores it) and `backfillEarnings` (the last quarters of every holding, newest first, within the daily
 * AI allowance; one row read when complete or waiting). All run only below 60 % of the budget and are dropped, not deferred, above it: the
 * next watch or the next 15-minute backfill step finds the work again. Without `SEC_CONTACT` or the AI binding they finish at once without any outbound call.
 */
export const EARNINGS_JOB_FACTORIES: JobFactories = {
  watchEarnings: (context) => createWatchEarningsJob(() => earningsJobDeps(context)),
  fetchEarningsSummary: (context) => createFetchEarningsSummaryJob(() => earningsJobDeps(context)),
  backfillEarnings: (context) => createBackfillEarningsJob(() => earningsJobDeps(context)),
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
  // One user's step: at most 3 notifications to 10 devices, one subrequest per push.
  notifyDividends: MAX_PUSHES_PER_USER_STEP,
  // A watch step: the ticker table (once) and one submissions request per candidate, at most `CHECKS_PER_STEP` (10).
  watchEarnings: CHECKS_PER_STEP + 4,
  // A release: the filing index, up to three documents, the estimate and at most two model calls.
  fetchEarningsSummary: 8,
  // A backfill step: the ticker table and four submissions lists, or one release (its index, up to four documents, the estimate).
  backfillEarnings: BACKFILL_STEP_SUBREQUESTS,
};

export const ALL_JOB_FACTORIES: JobFactories = { ...CORE_JOB_FACTORIES, ...PRICE_JOB_FACTORIES, ...EARNINGS_JOB_FACTORIES };

/** The jobs that have a handler: schedules of other jobs are not kept (they would only fail and retry). */
export const registeredJobs = (factories: JobFactories = ALL_JOB_FACTORIES): JobName[] => Object.keys(factories) as JobName[];

/**
 * The schedules the Hub keeps: those of the registered jobs (the price schedules among them once the price service is registered). The
 * earnings watch is kept only while the feature has what it needs (`earningsOn`): without the SEC contact or the AI binding it would wake the
 * Durable Object 23 times a day to do nothing.
 */
export const schedulesFor = (factories: JobFactories = ALL_JOB_FACTORIES, earningsOn = true): ScheduledJob[] => {
  const known = new Set<string>(registeredJobs(factories));
  const earningsJobs = new Set<string>([JOBS.watchEarnings, JOBS.backfillEarnings]);
  return SCHEDULED_JOBS.filter((schedule) => known.has(schedule.job) && (earningsOn || !earningsJobs.has(schedule.job)));
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
 * refresh. Its next scheduled slot comes within 15 minutes, so a deferral would only pile up hourly retries behind it. The notification
 * run is dropped too: what is due stays un-ledgered, and the next run (the 09:00 one, or the next sync that books something) sends it.
 */
const dropsWhenDenied = (name: JobName): boolean => JOB_CEILINGS[name] === 'ok' || name === 'refreshT212Quotes' || name === 'notifyDividends';

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
