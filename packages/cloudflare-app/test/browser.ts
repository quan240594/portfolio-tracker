import type { Item } from '@portfolio/platform';
import type { FakeGithub, FakeLogos, FakePrices, FakePush, FakeSecService, FakeTrading212 } from './fakes.js';

export interface DrainOptions {
  /**
   * Jobs that may stay pending. With a frozen Hub clock (the budget tests) a job that the alarm defers by a second never comes due, so a
   * test that is not about it (enrichment after a sync) says so instead of waiting for it.
   */
  ignoreJobs?: readonly string[];
}

/** What a test sees of the deployed app, whatever runs it (Node with an in-process Hub, or real workerd through Miniflare). */
export interface Stack {
  readonly origin: string;
  readonly github: FakeGithub;
  readonly trading212: FakeTrading212;
  readonly prices: FakePrices;
  readonly logos: FakeLogos;
  readonly push: FakePush;
  readonly sec: FakeSecService;
  /** Sends a request to the Worker exactly as a browser would reach it. */
  send(path: string, init?: RequestInit): Promise<Response>;
  /** Runs the Hub's alarm until no job is left (Node), or waits until the Hub reports no pending job (workerd). */
  drain(options?: DrainOptions): Promise<void>;
  /** Enqueues a job on the Hub as the schedule or an event would (the tests cannot wait for a real cron slot). */
  enqueue(job: string, payload: unknown): Promise<void>;
  /** Writes items straight into the Hub's store (profiles and calendar dates the price service would have stored). */
  seed(items: readonly Item[]): Promise<void>;
  /** Jobs that ran out of attempts (must stay empty: a denied or unconfigured job is skipped or deferred, not failed). */
  failedJobs(): Promise<{ job: string; error: string | null }[]>;
  /** Names of the cron schedules the Hub keeps. */
  schedules(): Promise<string[]>;
  /** The Hub's armed alarm (epoch ms) or null. */
  alarmAt(): Promise<number | null>;
  /** Fires the daily cron trigger of the Worker. */
  cron(): Promise<void>;
  /** Moves the Hub's clock forward; only stacks with a pinned clock support it. */
  advance?(ms: number): void;
  dispose(): Promise<void>;
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Send no `Origin` header (a cross-site request carries a foreign one). Default: same origin. */
  origin?: string | null;
}

/** A browser: keeps the cookies of the origin, follows nothing by itself. */
export class Browser {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly stack: Stack) {}

  private absorb(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = cookie.split(';').map((part) => part.trim());
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get cookieNames(): string[] {
    return [...this.cookies.keys()];
  }

  async request(path: string, options: CallOptions = {}): Promise<Response> {
    const { method = 'GET', body, query, headers = {}, origin = this.stack.origin } = options;
    const search = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : '';
    const sent: Record<string, string> = { ...headers };
    if (this.cookies.size > 0) sent.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    if (origin !== null && method !== 'GET') sent.origin = origin;
    if (body !== undefined && sent['content-type'] === undefined) sent['content-type'] = 'application/json';
    const response = await this.stack.send(`${path}${search}`, {
      method,
      headers: sent,
      redirect: 'manual',
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    this.absorb(response);
    return response;
  }

  /** The whole OAuth round trip with the fake GitHub; resolves the callback response. */
  async signIn(returnTo = '/'): Promise<Response> {
    const login = await this.request('/auth/login', { query: { returnTo } });
    const state = new URL(login.headers.get('location') ?? '').searchParams.get('state') ?? '';
    return this.request('/auth/callback', { query: { code: 'fake-code', state } });
  }
}
