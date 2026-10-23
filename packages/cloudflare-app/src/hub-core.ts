import {
  BudgetGuard,
  JOBS,
  LogoService,
  ItemLogoStore,
  createLogoSources,
  durableObjectGbSeconds,
  fetchRequestToPortable,
  portableToFetchResponse,
  withBudget,
  type JobRegistry,
  type Logger,
  type MarketDataService,
  type MetricLimits,
  type PortableHandler,
  type PortableRequest,
  type PortableResponse,
} from '@portfolio/platform';
import { ItemManagementRepository, ItemNotificationRepository, ItemRepository, createApp, type Deps } from '@portfolio/api';
import { ItemBrokerStore, ItemQuoteStore, SecretCredentialStore, Trading212Client } from '@portfolio/broker-sync';
import { AlarmDiagnostics, MAX_FILE_BYTES, createDurableObjectPlatform, describeDiagnosticError, uploadTokenFromUrl, type AlarmJobQueueOptions, type ArmEvent, type DurableObjectPlatform } from '@portfolio/cloudflare';
import type { AiLike } from '@portfolio/earnings';
import { createMarketDataService } from '@portfolio/prices';
import { parseImportObjectKey } from '@portfolio/shared';
import { readBodyBounded } from './body.js';
import type { HubConfig } from './config.js';
import { createEarningsApi, earningsConfigured, neuronMeter } from './earnings.js';
import { createHubLogoRoute, logoLookupGate } from './logos.js';
import { alarmReport, finishOf, limitOf, triggerOf, type AlarmInfo } from './diagnostics.js';
import { ALL_JOB_FACTORIES, createJobRegistry, eventsFor, priceJobDeps, schedulesFor, type JobContext, type JobFactories } from './jobs.js';
import { pricesStatus } from './prices-status.js';
import { pushConfig } from './push.js';
import { ARM_PATH, REQUEST_ID_HEADER, SUBJECT_HEADER, stripApiPrefix, userIdOfSubject } from './protocol.js';
import { errorResponse } from './responses.js';
import type { HubState } from './runtime.js';
import { SubrequestBudget } from './subrequests.js';

export interface HubOptions {
  /** The clock of the ledger, the schedules and the application. Defaults to the system clock. */
  now?: () => Date;
  /** Caps the budget guard measures against. Defaults to the free-plan table; tests pass small ones. */
  limits?: MetricLimits;
  /** Buffered usage records before the ledger is written (it is also written at the end of every request and alarm). Default 20. */
  flushAfter?: number;
  logger?: Logger;
  /** The job handlers. Defaults to the core jobs plus whatever `PRICE_JOB_FACTORIES` registers. */
  jobFactories?: JobFactories;
  /** The `fetch` used for outbound calls (Trading 212, price providers); counted against the subrequest budget. Defaults to the global one. */
  fetch?: typeof fetch;
  /** Pause used by the price service's HTTP client (backoff). Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** The Workers AI binding (`env.AI`); without it the earnings feature is off. */
  ai?: AiLike;
  /** Retry policy of the alarm queue (tests shorten the backoff). */
  queue?: Pick<AlarmJobQueueOptions, 'baseBackoffMs' | 'maxAttempts' | 'maxStepsPerRun' | 'maxRunMs'>;
}

const DEFAULT_FLUSH_AFTER = 20;
const NO_ALARM_INFO: AlarmInfo = {};
const UPLOAD_GATE_PASS: PortableResponse = { status: 204, headers: {}, body: '' };

/**
 * Everything the Hub Durable Object does, as plain TypeScript over a structural `ctx`: the platform ports on SQLite, the
 * budget guard (write-behind ledger in the same database), the API handler assembled over those ports exactly like the
 * Lambda entry does over the AWS ones, the upload route and the alarm with the job handlers. The `Hub` class is a thin shell
 * around it, so all of this runs (and is covered) in Node as well as in workerd.
 */
export class HubCore {
  readonly platform: DurableObjectPlatform;
  readonly guard: BudgetGuard;
  /** The alarm diagnostics log (ring buffers in the same SQLite, see docs/architecture.md "Alarm diagnostics"). */
  readonly diagnostics: AlarmDiagnostics;
  private readonly app: PortableHandler;
  private readonly uploadGate: PortableHandler;
  private readonly logoRoute: (request: PortableRequest) => Promise<PortableResponse> | undefined;
  private readonly factories: JobFactories;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger | undefined;
  private readonly ai: AiLike | undefined;
  private readonly storage: HubState['storage'];
  /** Id of the diagnostics row of the alarm run in progress (arms made meanwhile point at it). */
  private currentRun: number | undefined;
  /** Whether the end-of-run `setAlarm` of the current run was already seen (the run row carries it; a second one is recorded). */
  private finalArmSeen = false;

  constructor(
    ctx: HubState,
    private readonly config: HubConfig,
    options: HubOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
    this.ai = options.ai;
    this.storage = ctx.storage;
    this.factories = options.jobFactories ?? ALL_JOB_FACTORIES;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // The guard exists only after the platform (its ledger is a platform adapter): rows of the first statements are not counted.
    const guardRef: { current?: BudgetGuard } = {};
    this.platform = createDurableObjectPlatform({
      ctx,
      secretsKey: config.secretsKey,
      now: this.now,
      uploadBaseUrl: config.origin,
      // A schedule whose job has no handler would only fail and retry, so it is not kept.
      schedules: schedulesFor(this.factories, earningsConfigured(config, options.ai)),
      onUsage: ({ rowsRead, rowsWritten }) => {
        void guardRef.current?.recordRows({ read: rowsRead, written: rowsWritten });
      },
      onArm: (event) => this.noteArm(event),
      ...options.queue,
    });
    this.diagnostics = new AlarmDiagnostics(ctx.storage, {
      now: this.now,
      onUsage: ({ rowsRead, rowsWritten }) => {
        void guardRef.current?.recordRows({ read: rowsRead, written: rowsWritten });
      },
    });
    this.guard = new BudgetGuard({
      store: this.platform.usage,
      now: this.now,
      limits: options.limits,
      logger: options.logger,
      flushAfter: options.flushAfter ?? DEFAULT_FLUSH_AFTER,
      readStorageBytes: () => ctx.storage.sql.databaseSize ?? 0,
    });
    guardRef.current = this.guard;
    const deps = this.buildDeps();
    this.logoRoute = createHubLogoRoute({ service: this.buildLogoService(options.logger), deps, fetch: this.fetchImpl });
    const application = createApp(() => deps);
    this.app = withBudget((request) => (request.method === 'GET' && request.path === '/usage' ? this.usage() : this.ownRoute(request) ?? application(request)), this.guard);
    this.uploadGate = withBudget(() => Promise.resolve(UPLOAD_GATE_PASS), this.guard);
  }

  /** Initialises the cron schedules and arms the alarm. The Hub shell calls it inside `blockConcurrencyWhile`. */
  async start(): Promise<void> {
    await this.platform.arm();
  }

  /** `fetch` of the Durable Object: the keep-alive call, the upload route and the API. Records the request and writes the ledger at the end. */
  async handle(request: Request): Promise<Response> {
    const started = Date.now();
    try {
      return await this.dispatch(request);
    } finally {
      await this.settle(started);
    }
  }

  /**
   * `alarm(alarmInfo)` of the Durable Object: counts as one request, runs the due jobs behind the guard, re-arms itself. The
   * diagnostics row is written first and completed last, so a run that is cut short leaves a start without a finish.
   */
  async alarm(info: AlarmInfo = NO_ALARM_INFO): Promise<void> {
    const started = Date.now();
    const runId = await this.beginRun(info);
    await this.guard.record({ durableObjectRequests: 1 });
    const budget = new SubrequestBudget();
    try {
      const report = await this.platform.runAlarm(this.registry(budget));
      this.endRun(runId, finishOf(report, budget.used));
    } catch (error) {
      this.endRun(runId, { outcome: 'failed', jobs: [], subrequests: budget.used, nextAlarmAt: null, error: describeDiagnosticError(error) });
      throw error;
    } finally {
      this.currentRun = undefined;
      await this.settle(started);
    }
  }

  /** `GET /api/diagnostics/alarms`: what the alarm did lately (see `AlarmDiagnosticsReport` in `@portfolio/shared`). */
  async alarmDiagnostics(limit: string | undefined): Promise<PortableResponse> {
    const count = limitOf(limit);
    const report = alarmReport({
      nowMs: this.now().getTime(),
      runs: this.diagnostics.recentRuns(count),
      arms: this.diagnostics.recentArms(count),
      summary: this.diagnostics.summary(),
      alarmAt: await this.storage.getAlarm(),
      pending: this.platform.jobs.pending(),
    });
    return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(report) };
  }

  /** Starts the diagnostics row of an alarm invocation. Never throws: the log must not be able to break the alarm. */
  private async beginRun(info: AlarmInfo): Promise<number | undefined> {
    try {
      const scheduledFor = info.scheduledTime ?? (await this.storage.getAlarm());
      const id = this.diagnostics.begin({
        retryCount: info.retryCount ?? 0,
        isRetry: info.isRetry ?? false,
        scheduledFor,
        trigger: this.triggerNow(),
      });
      this.currentRun = id;
      this.finalArmSeen = false;
      return id;
    } catch (error) {
      this.logger?.warn('The alarm diagnostics could not record a run start', { error: describeDiagnosticError(error).message });
      return undefined;
    }
  }

  /** What is due right now, or `unknown` when the queue cannot be read (that must not cost the run its row). */
  private triggerNow(): string {
    try {
      return triggerOf(this.platform.jobs.pending(), this.now().getTime());
    } catch {
      return 'unknown';
    }
  }

  private endRun(runId: number | undefined, finish: Parameters<AlarmDiagnostics['finish']>[1]): void {
    if (runId === undefined) return;
    try {
      this.diagnostics.finish(runId, finish);
    } catch (error) {
      this.logger?.warn('The alarm diagnostics could not record a run end', { error: describeDiagnosticError(error).message });
    }
  }

  /** Records a `setAlarm` of the queue. The normal re-arm at the end of a run is on the run row, so only the others (and a repeated one) get an arm row. */
  private noteArm(event: ArmEvent): void {
    if (event.reason === 'rearm-after-run' && !this.finalArmSeen) {
      this.finalArmSeen = true;
      return;
    }
    try {
      this.diagnostics.recordArm(event.reason, event.alarmAt, this.currentRun ?? null);
    } catch (error) {
      this.logger?.warn('The alarm diagnostics could not record an arm', { error: describeDiagnosticError(error).message });
    }
  }

  private context(budget: SubrequestBudget): JobContext {
    const queue = this.platform.jobs;
    return {
      items: this.platform.items,
      secrets: this.platform.secrets,
      files: this.platform.files,
      queue,
      events: eventsFor(queue, this.factories),
      now: this.now,
      config: this.config,
      budget,
      fetch: budget.wrap(this.fetchImpl),
      sleep: this.sleep,
      ...(this.ai === undefined ? {} : { ai: this.ai }),
      neurons: neuronMeter(this.guard, this.config.earnings.dailyNeurons),
    };
  }

  private registry(budget: SubrequestBudget): JobRegistry {
    return createJobRegistry(this.context(budget), { guard: this.guard }, this.factories);
  }

  /**
   * The platform's `MarketDataService` over the Hub's store and the price service: the jobs run to completion inside one call.
   * Not on any request path (a full run takes far more than 45 subrequests, so the counted `fetch` fails it visibly instead of
   * letting the runtime do it): the API reads what the alarm-driven jobs stored, which is why price-dependent endpoints work
   * without calling it. Use it from tests and tooling.
   */
  marketData(): MarketDataService {
    return createMarketDataService(priceJobDeps(this.context(new SubrequestBudget())));
  }

  /** Duration cost of the invocation, then the buffered ledger rows. Never throws. */
  private async settle(startedMs: number): Promise<void> {
    await this.guard.record({ durableObjectGbSeconds: durableObjectGbSeconds(Date.now() - startedMs) });
    await this.guard.flush();
  }

  private async dispatch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === ARM_PATH) return this.keepAlive();
    const token = request.method === 'PUT' ? uploadTokenFromUrl(request.url) : undefined;
    if (token !== undefined) return this.upload(request, token);
    const userId = userIdOfSubject(request.headers.get(SUBJECT_HEADER));
    if (userId === undefined) return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');
    return this.api(request, userId);
  }

  private async keepAlive(): Promise<Response> {
    await this.guard.record({ durableObjectRequests: 1 });
    await this.platform.arm('keep-alive');
    return new Response(null, { status: 204 });
  }

  /** `PUT /api/uploads/<token>`: the token is the credential. Counted and refused by the guard like a write. */
  private async upload(request: Request, token: string): Promise<Response> {
    const gate = await this.uploadGate({ method: 'PUT', path: '/uploads', query: {}, headers: {} });
    if (gate !== UPLOAD_GATE_PASS) return portableToFetchResponse(gate);
    const bytes = await readBodyBounded(request, MAX_FILE_BYTES);
    if (bytes === undefined) return new Response('The file is larger than the upload limit', { status: 413 });
    const result = await this.platform.acceptUpload(token, bytes);
    if (!result.ok) return new Response(result.reason, { status: result.status });
    const target = parseImportObjectKey(result.key);
    if (target) await this.platform.jobs.enqueue({ job: JOBS.importUploaded, payload: target });
    return new Response(null, { status: 204 });
  }

  private async api(request: Request, userId: string): Promise<Response> {
    const portable = await fetchRequestToPortable(request);
    const { [SUBJECT_HEADER]: _subject, [REQUEST_ID_HEADER]: requestId, ...headers } = portable.headers;
    const forwarded: PortableRequest = {
      ...portable,
      path: stripApiPrefix(portable.path),
      headers,
      identity: { subject: userId },
      ...(requestId ? { requestId } : {}),
    };
    return portableToFetchResponse(await this.app(forwarded));
  }

  /** Routes the Hub serves itself, next to the API: `GET /prices/status` and `GET /logos/{symbol}`. */
  private ownRoute(request: PortableRequest): Promise<PortableResponse> | undefined {
    if (request.method === 'GET' && request.path === '/prices/status') return this.pricesStatus(request.identity?.subject);
    if (request.method === 'GET' && request.path === '/diagnostics/alarms') return this.alarmDiagnostics(request.query.limit);
    return this.logoRoute(request);
  }

  /** The logo service over the Hub's SQLite: one row per logo, lookups only while the usage budget is calm (see docs/architecture.md "Company logos"). */
  private buildLogoService(logger?: Logger): LogoService {
    const { logos } = this.config;
    return new LogoService({
      store: new ItemLogoStore(this.platform.items),
      sources: createLogoSources(logos.sources, { logoDevToken: logos.logoDevToken, t212Base: logos.t212Base, allowAnyHost: logos.allowAnyHost }),
      now: this.now,
      hourlyLimit: logos.hourlyLimit,
      negativeTtlDays: logos.negativeTtlDays,
      allowFetch: logoLookupGate(this.guard, logger),
      logger,
    });
  }

  /** The sources that are on, and how fresh the Trading 212 quotes of the signed-in user are (one read of the status item). */
  private async pricesStatus(userId: string | undefined): Promise<PortableResponse> {
    const t212 = userId === undefined ? null : await new ItemQuoteStore(this.platform.items).getStatus(userId);
    return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(pricesStatus(this.config.prices, t212)) };
  }

  private usage(): Promise<PortableResponse> {
    return this.guard.snapshot().then((snapshot) => ({ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(snapshot) }));
  }

  /** The API's dependencies over the SQLite ports: the Cloudflare counterpart of `createAwsDeps`. */
  private buildDeps(): Deps {
    const { items, secrets, files, jobs } = this.platform;
    return {
      repo: new ItemRepository(items),
      mgmt: new ItemManagementRepository(items),
      events: eventsFor(jobs, this.factories),
      files,
      notify: { repo: new ItemNotificationRepository(items), push: pushConfig(this.config, this.fetchImpl) },
      earnings: createEarningsApi({ items, config: this.config, ai: this.ai, queue: jobs, now: this.now, guard: this.guard }),
      broker: {
        store: new ItemBrokerStore(items),
        credentials: new SecretCredentialStore(secrets, this.config.brokerSecretPrefix),
        // One quick attempt, like the Lambda: the person at the keyboard is waiting (one subrequest).
        verify: async (credentials) => {
          const client = new Trading212Client({ credentials, maxAttempts: 1, timeoutMs: 6000, fetchFn: this.fetchImpl });
          return { accountCurrency: (await client.accountSummary()).currency.toUpperCase() };
        },
        jobs,
      },
      // `cognito` is the "identity required" mode: the Worker's verified owner is the only way in (fail closed).
      config: { baseCurrency: this.config.baseCurrency, authMode: 'cognito', demoUserId: 'demo', corsAllowedOrigin: this.config.origin },
      now: this.now,
      uuid: () => crypto.randomUUID(),
    };
  }
}
