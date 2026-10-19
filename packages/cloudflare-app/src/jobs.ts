import {
  JOB_CEILINGS,
  QueueEventPublisher,
  guardJob,
  logger,
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
  type SecretStore,
} from '@portfolio/platform';
import { ItemBrokerStore, SecretCredentialStore, Trading212Client, brokerSyncJob, type SyncDeps } from '@portfolio/broker-sync';
import { ItemIngestStore, importUploadedJob } from '@portfolio/ingest';
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
}

export type JobFactory<N extends JobName> = (context: JobContext) => JobHandler<JobPayloads[N]>;
export type JobFactories = { [N in JobName]?: JobFactory<N> };

/** Subrequests one Trading 212 sync step can use: `T212_PAGES_PER_STEP` pages, each retried up to `T212_MAX_ATTEMPTS` times, plus the exchange list. */
export const T212_PAGES_PER_STEP = 5;
export const T212_MAX_ATTEMPTS = 3;

const noEvents: EventPublisher = { transactionsChanged: () => Promise.resolve() };

/** Jobs that run on the Hub today: the CSV import and the Trading 212 sync (both platform-neutral, from `services/*`). */
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
    return brokerSyncJob(() => deps);
  },
};

/**
 * REGISTRATION POINT OF THE PRICE SERVICE. The TypeScript price service (`@portfolio/prices`) is not merged yet. When it is,
 * add its three job factories here and nothing else changes: the alarm runs them behind `guardJob` like every other job, the
 * scheduled refreshes (`SCHEDULED_JOBS`: `prices-refresh`, `prices-calendar`) start being scheduled, and `transactionsChanged`
 * starts enqueuing `enrichTransactions` jobs.
 *
 *   refreshPrices: (context) => refreshPricesJob(...),
 *   refreshCalendar: (context) => refreshCalendarJob(...),
 *   enrichTransactions: (context) => enrichTransactionsJob(...),
 *
 * A price job makes at most `context.budget.remaining()` calls through `context.fetch` and returns `{ done: false, next }`
 * to continue in a later invocation (add its reserve to `JOB_SUBREQUEST_RESERVE`).
 */
export const PRICE_JOB_FACTORIES: JobFactories = {};

/** Subrequests a step of the job needs left; the alarm defers the step to a fresh invocation when fewer remain. */
export const JOB_SUBREQUEST_RESERVE: Readonly<Partial<Record<JobName, number>>> = {
  syncBroker: T212_PAGES_PER_STEP * T212_MAX_ATTEMPTS + 3,
};

export const ALL_JOB_FACTORIES: JobFactories = { ...CORE_JOB_FACTORIES, ...PRICE_JOB_FACTORIES };

/** The jobs that have a handler: schedules of other jobs are not kept (they would only fail and retry). */
export const registeredJobs = (factories: JobFactories = ALL_JOB_FACTORIES): JobName[] => Object.keys(factories) as JobName[];

/** True when `enrichTransactions` has a handler, i.e. a price service is registered. */
export const hasPriceService = (factories: JobFactories = ALL_JOB_FACTORIES): boolean => factories.enrichTransactions !== undefined;

/** The `EventPublisher` of the Hub: events become jobs once there is a consumer for them. */
export const eventsFor = (queue: JobQueue, factories: JobFactories = ALL_JOB_FACTORIES): EventPublisher =>
  hasPriceService(factories) ? new QueueEventPublisher(queue) : noEvents;

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
      if (JOB_CEILINGS[name] === 'ok') return { done: true, result: { skipped: decision.reason } };
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
