import type { FetchLike } from '../http.js';

/**
 * A route's scripted responses (`unknown`): a plain value is a 200 JSON body; `{status}` an HTTP error (with
 * `Retry-After: 0`), `{text}` a raw body, an Error a network failure.
 */
export interface FakeRoute {
  /** Substring of the URL. */
  match: string;
  /** Replies in order; the last one repeats once it is the only one left. */
  responses: unknown[];
}

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

const hasOnly = (value: unknown, key: string): value is Record<string, unknown> => typeof value === 'object' && value !== null && Object.keys(value).length === 1 && key in value;

function respond(reply: unknown): Response {
  if (hasOnly(reply, 'status')) return new Response('error', { status: Number(reply.status), headers: { 'Retry-After': '0' } });
  if (hasOnly(reply, 'text')) return new Response(String(reply.text), { status: 200 });
  return new Response(JSON.stringify(reply), { status: 200 });
}

/** Scripted `fetch` that records every request; no network, no timers. */
export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: FakeRoute[];

  constructor(routes: readonly FakeRoute[] = []) {
    this.routes = routes.map((route) => ({ match: route.match, responses: [...route.responses] }));
  }

  /** Adds a route that takes precedence over the earlier ones. */
  add(match: string, ...responses: unknown[]): this {
    this.routes.unshift({ match, responses });
    return this;
  }

  get urls(): string[] {
    return this.requests.map((request) => request.url);
  }

  readonly fetch: FetchLike = (url, init) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
    this.requests.push({ url, headers, signal: init?.signal ?? undefined });
    const route = this.routes.find((candidate) => url.includes(candidate.match) && candidate.responses.length > 0);
    if (route === undefined) return Promise.reject(new Error(`unexpected request ${url}`));
    const reply = route.responses.length > 1 ? route.responses.shift() : route.responses[0];
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(respond(reply));
  };
}
