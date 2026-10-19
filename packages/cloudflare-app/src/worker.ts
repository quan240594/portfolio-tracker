import {
  createAuthFetchHandler,
  createGithubIdentityResolver,
  portableToFetchResponse,
  requireSameOrigin,
  type GithubAuthConfig,
  type IdentityResolver,
} from '@portfolio/platform';
import { MAX_FILE_BYTES, uploadTokenFromUrl } from '@portfolio/cloudflare';
import { MAX_API_BODY_BYTES, readBodyBounded } from './body.js';
import { readWorkerConfig, type WorkerConfigOptions } from './config.js';
import { ARM_PATH, HUB_NAME, HUB_ORIGIN, REQUEST_ID_HEADER, SUBJECT_HEADER } from './protocol.js';
import { errorResponse, jsonResponse } from './responses.js';
import type { ExecutionContextLike, HubStub, ScheduledControllerLike, WorkerEnv } from './runtime.js';

type Identify = IdentityResolver<Request>['identify'];
type Ready = { ok: true; auth: (request: Request) => Promise<Response | undefined>; identify: Identify; origin: string } | { ok: false; problems: string[] };

const FORWARDED_HEADERS = ['content-type', 'accept'] as const;
const NO_BODY_METHODS = new Set(['GET', 'HEAD']);

const isApiPath = (pathname: string): boolean => pathname === '/usage' || pathname === '/api' || pathname.startsWith('/api/');

function ready(auth: GithubAuthConfig): Ready & { ok: true } {
  return { ok: true, auth: createAuthFetchHandler(auth), identify: createGithubIdentityResolver(auth).identify, origin: auth.origin };
}

const hubOf = (env: WorkerEnv): HubStub => env.HUB.get(env.HUB.idFromName(HUB_NAME));

/** Copy of a Hub response with the headers every Worker answer carries. */
function fromHub(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set('x-content-type-options', 'nosniff');
  return copy;
}

function toHub(request: Request, subject: string | undefined, body: Uint8Array<ArrayBuffer> | undefined): Request {
  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // Set here and nowhere else: whatever the client sent under these names was never copied.
  if (subject !== undefined) headers.set(SUBJECT_HEADER, subject);
  headers.set(REQUEST_ID_HEADER, crypto.randomUUID());
  return new Request(`${HUB_ORIGIN}${url.pathname}${url.search}`, { method: request.method, headers, ...(body && body.byteLength > 0 ? { body } : {}) });
}

async function callHub(env: WorkerEnv, request: Request): Promise<Response> {
  try {
    return fromHub(await hubOf(env).fetch(request));
  } catch (error) {
    console.error('Hub call failed', error instanceof Error ? error.name : 'error');
    return errorResponse(502, 'HUB_UNAVAILABLE', 'The data service is not available right now, try again in a moment');
  }
}

/**
 * The Worker in front of the Hub: it serves the static app, the GitHub sign-in (`/auth/*`), the public upload route and
 * the authenticated API (`/api/*`, `/usage`), and keeps the Hub's alarm armed from the daily cron trigger. It does no heavy
 * work (a cookie MAC check and a forward), so it stays far below the free plan's 10 ms of CPU per request.
 */
export function createWorker(options: WorkerConfigOptions = {}) {
  const cache = new WeakMap<object, Ready>();

  function readyFor(env: WorkerEnv): Ready {
    let current = cache.get(env);
    if (!current) {
      const config = readWorkerConfig(env, options);
      current = config.ok ? ready(config.config) : config;
      cache.set(env, current);
    }
    return current;
  }

  const notConfigured = (problems: string[]) => errorResponse(503, 'NOT_CONFIGURED', `The app is not configured: ${problems.join('; ')}`);

  async function upload(request: Request, env: WorkerEnv): Promise<Response> {
    const bytes = await readBodyBounded(request, MAX_FILE_BYTES);
    if (bytes === undefined) return new Response('The file is larger than the upload limit', { status: 413 });
    return callHub(env, toHub(request, undefined, bytes));
  }

  async function api(request: Request, env: WorkerEnv, session: Extract<Ready, { ok: true }>): Promise<Response> {
    const crossOrigin = requireSameOrigin(request, session.origin);
    if (crossOrigin) return portableToFetchResponse(crossOrigin);
    const identity = await session.identify(request);
    if (!identity) return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');
    const body = NO_BODY_METHODS.has(request.method) ? undefined : await readBodyBounded(request, MAX_API_BODY_BYTES);
    if (!NO_BODY_METHODS.has(request.method) && body === undefined) return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large');
    return callHub(env, toHub(request, identity.subject, body));
  }

  async function fetchHandler(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') return jsonResponse(200, { status: 'ok' });
    if (request.method === 'PUT' && uploadTokenFromUrl(request.url) !== undefined) return upload(request, env);
    const isAuth = pathname === '/auth' || pathname.startsWith('/auth/');
    if (!isAuth && !isApiPath(pathname)) return env.ASSETS ? env.ASSETS.fetch(request) : errorResponse(404, 'NOT_FOUND', 'Not found');
    const session = readyFor(env);
    if (!session.ok) return notConfigured(session.problems);
    // The sign-in routes read the request body themselves, so the API path must not go through them.
    if (isAuth) return (await session.auth(request)) ?? errorResponse(404, 'NOT_FOUND', 'Not found');
    return api(request, env, session);
  }

  return {
    fetch: fetchHandler,
    /** The daily cron trigger: keeps the Hub's alarm armed (a deploy clears it) and the schedules alive. */
    async scheduled(_controller: ScheduledControllerLike, env: WorkerEnv, _context?: ExecutionContextLike): Promise<void> {
      const response = await hubOf(env).fetch(new Request(`${HUB_ORIGIN}${ARM_PATH}`, { method: 'POST' }));
      if (!response.ok) throw new Error(`The Hub did not accept the keep-alive call (HTTP ${response.status})`);
    },
  };
}
