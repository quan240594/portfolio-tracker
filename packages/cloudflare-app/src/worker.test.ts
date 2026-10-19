import { describe, expect, it, vi } from 'vitest';
import { MAX_FILE_BYTES } from '@portfolio/cloudflare';
import { Browser } from '../test/browser.js';
import { createNodeStack } from '../test/node-stack.js';
import { OWNER_ID } from '../test/fakes.js';
import { MAX_API_BODY_BYTES } from './body.js';
import type { WorkerEnv } from './runtime.js';

const withHub = (stack: Awaited<ReturnType<typeof createNodeStack>>, fetchHub: (request: Request) => Promise<Response>): WorkerEnv => ({
  ...stack.env,
  HUB: { idFromName: () => 'hub', get: () => ({ fetch: fetchHub }) },
});

describe('Worker without a complete configuration', () => {
  it('fails closed with 503 NOT_CONFIGURED naming the problem, but still serves health and the static app', async () => {
    const stack = await createNodeStack({ env: { SESSION_SECRET: undefined, GITHUB_CLIENT_SECRET: undefined } });
    const browser = new Browser(stack);
    for (const path of ['/api/portfolios', '/auth/session', '/usage']) {
      const response = await browser.request(path);
      expect(response.status, path).toBe(503);
      const text = JSON.stringify(await response.json());
      expect(text).toContain('NOT_CONFIGURED');
      expect(text).toContain('SESSION_SECRET');
      expect(text).toContain('GITHUB_CLIENT_SECRET');
    }
    expect((await browser.request('/health')).status).toBe(200);
    expect((await browser.request('/holdings')).status).toBe(200);
  });

  it('answers 404 for a static path when no assets are bound', async () => {
    const stack = await createNodeStack({ env: { ASSETS: undefined } });
    expect((await new Browser(stack).request('/holdings')).status).toBe(404);
  });
});

describe('Worker routing to the Hub', () => {
  it('forwards only what the Hub needs, with the verified subject and a fresh request id', async () => {
    const stack = await createNodeStack();
    const owner = new Browser(stack);
    await owner.signIn();
    const seen: Request[] = [];
    stack.env.HUB = withHub(stack, (request) => {
      seen.push(request);
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    }).HUB;
    const response = await owner.request('/api/portfolios?x=1', {
      method: 'POST',
      body: { name: 'N' },
      headers: { authorization: 'Bearer leak', 'x-pt-subject': 'github:1', 'x-request-id': 'client-chosen', accept: 'application/json' },
    });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const [forwarded] = seen;
    expect(forwarded!.url).toBe('https://hub.internal/api/portfolios?x=1');
    expect(forwarded!.headers.get('x-pt-subject')).toBe(`github:${OWNER_ID}`);
    expect(forwarded!.headers.get('x-request-id')).not.toBe('client-chosen');
    expect(forwarded!.headers.get('content-type')).toBe('application/json');
    expect(forwarded!.headers.get('accept')).toBe('application/json');
    for (const name of ['cookie', 'authorization', 'origin']) expect(forwarded!.headers.get(name), name).toBeNull();
    expect(await forwarded!.text()).toBe('{"name":"N"}');
  });

  it('answers 502 HUB_UNAVAILABLE without detail when the Hub throws', async () => {
    const stack = await createNodeStack();
    const owner = new Browser(stack);
    await owner.signIn();
    stack.env.HUB = withHub(stack, () => Promise.reject(new Error('secret internal detail'))).HUB;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await owner.request('/api/portfolios');
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret internal detail');
    expect(error).toHaveBeenCalledWith('Hub call failed', 'Error');
    error.mockRestore();
  });

  it('refuses an oversized API body and an oversized upload without calling the Hub', async () => {
    const stack = await createNodeStack();
    const owner = new Browser(stack);
    await owner.signIn();
    const hub = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    stack.env.HUB = withHub(stack, hub).HUB;
    const api = await owner.request('/api/portfolios', { method: 'POST', body: 'x'.repeat(MAX_API_BODY_BYTES + 1) });
    expect(api.status).toBe(413);
    expect((await api.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
    const upload = await new Browser(stack).request('/api/uploads/abcdefghijklmnopqrstuvwxyz', { method: 'PUT', body: new Uint8Array(MAX_FILE_BYTES + 1) });
    expect(upload.status).toBe(413);
    expect(hub).not.toHaveBeenCalled();
  });

  it('answers unknown /auth routes with 404', async () => {
    const stack = await createNodeStack();
    const owner = new Browser(stack);
    expect((await owner.request('/auth/unknown')).status).toBe(404);
  });

  it('fails the cron trigger visibly when the Hub rejects the keep-alive call', async () => {
    const stack = await createNodeStack();
    const env = withHub(stack, () => Promise.resolve(new Response(null, { status: 500 })));
    await expect(stack.worker.scheduled({}, env)).rejects.toThrow(/keep-alive/);
  });

  it('reads its configuration once per environment', async () => {
    const stack = await createNodeStack();
    const owner = new Browser(stack);
    await owner.signIn();
    stack.env.SESSION_SECRET = 'changed after the first request, ignored: the environment is immutable in a deployed isolate';
    expect((await owner.request('/api/portfolios')).status).toBe(200);
  });
});
