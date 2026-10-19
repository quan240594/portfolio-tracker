import type { JobRegistry } from '@portfolio/platform';
import { AlarmJobQueue, type AlarmJobQueueOptions, type AlarmReport } from './alarm-job-queue.js';
import { SqlFileStore, type AcceptUploadResult } from './file-store.js';
import { SqlItemStore } from './item-store.js';
import { SqlSecretStore } from './secret-store.js';
import { SqlUsageStore } from './usage-store.js';
import type { AlarmStorageHost, UsageSink } from './sql.js';

export interface DurableObjectPlatformOptions extends Omit<AlarmJobQueueOptions, 'onUsage' | 'now'> {
  /** The Durable Object's state: only `ctx.storage` is used. */
  ctx: { readonly storage: AlarmStorageHost };
  /** Base64 master key of the secret store (a Worker secret binding, at least 32 random bytes). */
  secretsKey: string;
  /** The clock. Defaults to `new Date()`. */
  now?: () => Date;
  /** Receives the rows read and written by every statement of every adapter (the input of the free-plan budget guard). */
  onUsage?: UsageSink;
  /** Origin that upload URLs are built on; may also be set later with `setUploadBaseUrl` (e.g. per request). */
  uploadBaseUrl?: string | (() => string);
}

export interface DurableObjectPlatform {
  items: SqlItemStore;
  secrets: SqlSecretStore;
  files: SqlFileStore;
  jobs: AlarmJobQueue;
  /** The budget guard's ledger (`BudgetGuard({ store: platform.usage })`): one row per UTC day. */
  usage: SqlUsageStore;
  /** Runs the due jobs and re-arms the alarm. Call from the Durable Object's `alarm()`. */
  runAlarm(handlers: JobRegistry): Promise<AlarmReport>;
  /** Initialises the cron schedules and arms the alarm. Call from the constructor inside `blockConcurrencyWhile`. */
  arm(): Promise<number | null>;
  /** The Worker's `PUT /api/uploads/<token>` route calls this with the request body (see `SqlFileStore`). */
  acceptUpload(token: string, body: Uint8Array | ArrayBuffer): Promise<AcceptUploadResult>;
  /** Sets the origin of upload URLs (call with `new URL(request.url).origin` while serving a request). */
  setUploadBaseUrl(origin: string): void;
}

/**
 * Builds every port adapter of the platform on one Durable Object's storage. The Hub Durable Object class calls it from
 * its constructor and keeps the result; `new Hub(ctx, env)` is the only place that knows Cloudflare.
 */
export function createDurableObjectPlatform({ ctx, secretsKey, now, onUsage, uploadBaseUrl, ...jobOptions }: DurableObjectPlatformOptions): DurableObjectPlatform {
  const { storage } = ctx;
  let baseUrl = uploadBaseUrl;
  const resolveBaseUrl = (): string => {
    const value = typeof baseUrl === 'function' ? baseUrl() : baseUrl;
    if (!value) throw new Error('The upload base URL is not set (pass uploadBaseUrl or call setUploadBaseUrl)');
    return value;
  };
  const jobs = new AlarmJobQueue(storage, { ...jobOptions, now, onUsage });
  const files = new SqlFileStore(storage, { uploadBaseUrl: resolveBaseUrl, now, onUsage });
  return {
    items: new SqlItemStore(storage, { onUsage }),
    secrets: new SqlSecretStore(storage, secretsKey, { onUsage }),
    files,
    jobs,
    usage: new SqlUsageStore(storage, { onUsage }),
    runAlarm: (handlers) => jobs.runAlarm(handlers),
    arm: () => jobs.arm(),
    acceptUpload: (token, body) => files.acceptUpload(token, body),
    setUploadBaseUrl: (origin) => {
      baseUrl = origin;
    },
  };
}
