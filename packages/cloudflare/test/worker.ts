import { DurableObject } from 'cloudflare:workers';
import { JOBS, type JobRegistry } from '@portfolio/platform';
import { createDurableObjectPlatform, SqlSecretStore, uploadTokenFromUrl, type DurableObjectPlatform, type SqlUsage } from '../src/index.js';

/**
 * The Worker Miniflare runs in the workerd tests: a SQLite-backed Durable Object that builds the platform adapters exactly
 * like the Hub will, and exposes them through a tiny JSON-RPC over `fetch`, so the shared contract suites can drive them
 * from Node unchanged. It also plays the part of the Hub's upload route (`PUT /api/uploads/<token>`).
 */
interface Env {
  HUB: DurableObjectNamespace;
  /** Service binding implemented in Node: runs the job handler a test registered. */
  NODE: { fetch(url: string, init: { method: string; body: string }): Promise<Response> };
  SECRETS_KEY: string;
}

interface RpcCall {
  target: 'items' | 'secrets' | 'files' | 'jobs' | 'usage' | 'admin';
  method: string;
  args: unknown[];
}

const FILES_HUB = 'files';

export class TestHub extends DurableObject<Env> {
  private nowMs = Date.UTC(2026, 0, 5, 9);
  private realClock = false;
  private hub = 'unknown';
  private readonly usage: SqlUsage = { rowsRead: 0, rowsWritten: 0 };
  private readonly platform: DurableObjectPlatform;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.platform = createDurableObjectPlatform({
      ctx,
      secretsKey: env.SECRETS_KEY,
      now: () => new Date(this.realClock ? Date.now() : this.nowMs),
      onUsage: (delta) => {
        this.usage.rowsRead += delta.rowsRead;
        this.usage.rowsWritten += delta.rowsWritten;
      },
      uploadBaseUrl: 'https://app.test',
      schedules: [],
      baseBackoffMs: 1_000,
    });
  }

  async fetch(request: Request): Promise<Response> {
    this.hub = request.headers.get('x-hub') ?? FILES_HUB;
    if (request.method === 'PUT') return this.acceptUpload(request);
    const call = (await request.json()) as RpcCall;
    try {
      const result = await this.dispatch(call);
      return Response.json({ result });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The Worker's upload route: the token in the path is the only credential. */
  private async acceptUpload(request: Request): Promise<Response> {
    const token = uploadTokenFromUrl(request.url);
    if (!token) return new Response('Not found', { status: 404 });
    const result = await this.platform.acceptUpload(token, await request.arrayBuffer());
    return result.ok ? new Response(null, { status: 204 }) : new Response(result.reason, { status: result.status });
  }

  async alarm(): Promise<void> {
    // With the fixed test clock a real alarm would fire for a time that is long past: only the real-clock hub runs it.
    if (this.realClock) await this.platform.runAlarm(this.handlers());
  }

  private handlers(): JobRegistry {
    const bridge = (job: string) => async (invocation: unknown) => {
      const response = await this.env.NODE.fetch('http://node/handle', { method: 'POST', body: JSON.stringify({ hub: this.hub, job, invocation }) });
      const body = (await response.json()) as { step?: unknown; error?: string };
      if (body.error !== undefined) throw new Error(body.error);
      return body.step;
    };
    return Object.fromEntries(Object.values(JOBS).map((job) => [job, bridge(job)])) as JobRegistry;
  }

  private dispatch({ target, method, args }: RpcCall): Promise<unknown> | unknown {
    if (target === 'admin') return this.admin(method, args);
    const adapter = this.platform[target] as unknown as Record<string, (...params: unknown[]) => unknown>;
    return adapter[method]!.apply(adapter, args);
  }

  private admin(method: string, args: unknown[]): Promise<unknown> | unknown {
    const storage = this.ctx.storage;
    switch (method) {
      case 'setNow':
        this.nowMs = args[0] as number;
        return undefined;
      case 'useRealClock':
        this.realClock = true;
        return undefined;
      case 'runAlarm':
        return this.platform.runAlarm(this.handlers());
      case 'nextJobDueAt':
        return this.platform.jobs.nextJobDueAt();
      case 'failedJobs':
        return this.platform.jobs.failedJobs();
      case 'getAlarm':
        return storage.getAlarm();
      case 'usage':
        return { ...this.usage };
      case 'resetUsage':
        this.usage.rowsRead = this.usage.rowsWritten = 0;
        return undefined;
      case 'sql':
        return storage.sql.exec(args[0] as string, ...(args.slice(1) as never[])).toArray();
      case 'secretsWithKey': {
        const [key, name, ...rest] = args as [string, keyof SqlSecretStore, ...unknown[]];
        const store = new SqlSecretStore(storage, key) as unknown as Record<string, (...params: unknown[]) => unknown>;
        return store[name]!(...rest);
      }
      default:
        throw new Error(`Unknown admin method ${method}`);
    }
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const hub = request.method === 'PUT' ? FILES_HUB : (request.headers.get('x-hub') ?? 'default');
    return env.HUB.get(env.HUB.idFromName(hub)).fetch(request);
  },
};
