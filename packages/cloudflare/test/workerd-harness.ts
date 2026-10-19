import { build } from 'esbuild';
import { Miniflare, Response as MiniflareResponse } from 'miniflare';
import { fileURLToPath } from 'node:url';
import type { JobHandler, JobInvocation, JobStep } from '@portfolio/platform';

const WORKER_ENTRY = fileURLToPath(new URL('./worker.ts', import.meta.url));

/** The master key of the test Durable Object (32 bytes of 0x01; a test value, not a secret). */
export const TEST_SECRETS_KEY = btoa(String.fromCodePoint(...new Array<number>(32).fill(1)));

type Handler = JobHandler<never>;

/** A real workerd (through Miniflare) running the test Worker, and the Node-side handles to drive it. */
export class WorkerdHub {
  private readonly handlers = new Map<string, Handler>();

  private constructor(private readonly mf: Miniflare) {}

  static async start(): Promise<WorkerdHub> {
    const bundle = await build({
      entryPoints: [WORKER_ENTRY],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      mainFields: ['module', 'main'],
      external: ['cloudflare:workers'],
      logLevel: 'silent',
    });
    const hub: { current?: WorkerdHub } = {};
    const mf = new Miniflare({
      modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0]!.text }],
      compatibilityDate: '2026-04-01',
      durableObjects: { HUB: { className: 'TestHub', useSQLite: true } },
      durableObjectsPersist: false,
      bindings: { SECRETS_KEY: TEST_SECRETS_KEY },
      serviceBindings: { NODE: (request) => hub.current!.runHandler(request) },
    });
    await mf.ready;
    hub.current = new WorkerdHub(mf);
    return hub.current;
  }

  /** Installs the handler the Durable Object's alarm delivers `job` jobs of hub `name` to. */
  register(name: string, job: string, handler: Handler): void {
    this.handlers.set(`${name}/${job}`, handler);
  }

  private async runHandler(request: { json(): Promise<unknown> }): Promise<InstanceType<typeof MiniflareResponse>> {
    const { hub, job, invocation } = (await request.json()) as { hub: string; job: string; invocation: JobInvocation<never> };
    const handler = this.handlers.get(`${hub}/${job}`);
    try {
      if (!handler) throw new Error(`No Node handler for ${hub}/${job}`);
      const step: JobStep = await handler(invocation);
      return MiniflareResponse.json({ step });
    } catch (error) {
      return MiniflareResponse.json({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Calls `target.method(...args)` on the Durable Object of hub `name` (and rethrows its errors here). */
  async call(name: string, target: string, method: string, args: unknown[]): Promise<unknown> {
    const response = await this.mf.dispatchFetch('http://hub.test/rpc', {
      method: 'POST',
      headers: { 'x-hub': name, 'content-type': 'application/json' },
      body: JSON.stringify({ target, method, args }),
    });
    const body = (await response.json()) as { result?: unknown; error?: string };
    if (body.error !== undefined) throw new Error(body.error);
    return body.result;
  }

  /** A typed stand-in for the adapter `target` of hub `name`: every method call becomes an RPC. */
  proxy<T extends object>(name: string, target: 'items' | 'secrets' | 'files' | 'jobs'): T {
    return new Proxy({} as T, {
      get: (_, method) => (method === 'then' || typeof method !== 'string' ? undefined : (...args: unknown[]) => this.call(name, target, method, args)),
    });
  }

  /** What the browser does with an upload target. */
  async put(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
    const response = await this.mf.dispatchFetch(url, { method: 'PUT', headers, body });
    return { status: response.status, text: await response.text() };
  }

  dispose(): Promise<void> {
    return this.mf.dispose();
  }
}
