import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakePushService, createTestSubscriber, verifyVapidAuthorization, type TestSubscriber } from '../testing/push.js';
import { setLogger, type Logger } from '../logger.js';
import { MAX_PUSH_PAYLOAD_BYTES, createPushSender, mapPushStatus, parseRetryAfter, type PushSenderConfig } from './sender.js';
import { generateVapidKeys } from './vapid.js';

const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);
const SUBJECT = 'https://portfolio.example.workers.dev';

let vapid: PushSenderConfig['vapid'];
let subscriber: TestSubscriber;

beforeAll(async () => {
  vapid = { ...(await generateVapidKeys()), subject: SUBJECT, now: () => NOW };
  subscriber = await createTestSubscriber('https://fcm.googleapis.com/fcm/send/device-1');
});

const PAYLOAD = { type: 'declared', symbol: 'KMB', title: 'KMB declared $1.28 per share', body: 'Ex-date 06-11-2026', url: '/assets/KMB', tag: 'declared:KMB:2026-11-06' };

describe('createPushSender', () => {
  it('encrypts the payload, signs with VAPID and posts to the endpoint', async () => {
    const service = createFakePushService();
    const send = createPushSender({ vapid, fetch: service.fetch, now: () => NOW });
    const result = await send(subscriber.subscription, PAYLOAD, { ttl: 600, urgency: 'high', topic: 'ex-KMB' });
    expect(result).toEqual({ kind: 'ok', status: 201 });

    const [request] = service.requests;
    expect(request!.url).toBe(subscriber.subscription.endpoint);
    expect(request!.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '600', Urgency: 'high', Topic: 'ex-KMB' });
    const { claims, publicKey } = await verifyVapidAuthorization(request!.headers.Authorization!);
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe(SUBJECT);
    expect(publicKey).toBe(vapid.publicKey);
    expect(await subscriber.decrypt(request!.body)).toEqual(PAYLOAD);
  });

  it('defaults the TTL to one day and omits urgency and topic', async () => {
    const service = createFakePushService();
    await createPushSender({ vapid, fetch: service.fetch })(subscriber.subscription, PAYLOAD);
    expect(service.requests[0]!.headers).toMatchObject({ TTL: '86400' });
    expect(Object.keys(service.requests[0]!.headers)).not.toContain('Urgency');
    expect(Object.keys(service.requests[0]!.headers)).not.toContain('Topic');
  });

  it('uses the global fetch when none is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    expect(await createPushSender({ vapid })(subscriber.subscription, PAYLOAD)).toEqual({ kind: 'ok', status: 202 });
    spy.mockRestore();
  });

  it.each([
    [201, { kind: 'ok', status: 201 }],
    [200, { kind: 'ok', status: 200 }],
    [404, { kind: 'gone', status: 404 }],
    [410, { kind: 'gone', status: 410 }],
    [429, { kind: 'rate-limited', status: 429, retryAfterSeconds: 120 }],
    [500, { kind: 'retryable', reason: 'push-service-error', status: 500 }],
    [503, { kind: 'retryable', reason: 'push-service-error', status: 503 }],
    [413, { kind: 'rejected', reason: 'payload-too-large', status: 413 }],
    [400, { kind: 'rejected', reason: 'refused', status: 400 }],
    [403, { kind: 'rejected', reason: 'refused', status: 403 }],
    [302, { kind: 'rejected', reason: 'redirect', status: 302 }],
  ])('maps the status %i to %j', async (status, expected) => {
    const service = createFakePushService();
    service.respond(subscriber.subscription.endpoint, status, status === 429 ? { 'Retry-After': '120' } : {});
    expect(await createPushSender({ vapid, fetch: service.fetch })(subscriber.subscription, PAYLOAD)).toEqual(expected);
  });

  it('never follows redirects', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 307, headers: { location: 'https://evil.example/' } }));
    await createPushSender({ vapid, fetch: fetchFn })(subscriber.subscription, PAYLOAD);
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ redirect: 'manual', method: 'POST' });
  });

  it('reports a network error as retryable', async () => {
    const service = createFakePushService();
    service.fail(subscriber.subscription.endpoint);
    expect(await createPushSender({ vapid, fetch: service.fetch })(subscriber.subscription, PAYLOAD)).toEqual({ kind: 'retryable', reason: 'network' });
  });

  it('times a hanging request out and reports it as retryable', async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
    expect(await createPushSender({ vapid, fetch: hanging, timeoutMs: 20 })(subscriber.subscription, PAYLOAD)).toEqual({ kind: 'retryable', reason: 'timeout' });
  });

  it('refuses an endpoint outside the allow-list without any request, also for stored subscriptions', async () => {
    const service = createFakePushService();
    const send = createPushSender({ vapid, fetch: service.fetch });
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://example.com/x', 'https://fcm.googleapis.com@example.com/x']) {
      expect(await send({ ...subscriber.subscription, endpoint }, PAYLOAD)).toEqual({ kind: 'rejected', reason: 'invalid-endpoint' });
    }
    expect(service.requests).toHaveLength(0);
  });

  it('honours a configured allow-list', async () => {
    const service = createFakePushService();
    const send = createPushSender({ vapid, fetch: service.fetch, allowedHosts: ['push.example.org'] });
    expect((await send({ ...subscriber.subscription, endpoint: 'https://push.example.org/x' }, PAYLOAD)).kind).toBe('ok');
    expect((await send(subscriber.subscription, PAYLOAD)).kind).toBe('rejected');
  });

  it('refuses a payload above the cap and accepts one at the cap', async () => {
    const service = createFakePushService();
    const send = createPushSender({ vapid, fetch: service.fetch });
    const filler = (length: number) => ({ x: 'a'.repeat(length - '{"x":""}'.length) });
    expect(await send(subscriber.subscription, filler(MAX_PUSH_PAYLOAD_BYTES + 1))).toEqual({ kind: 'rejected', reason: 'payload-too-large' });
    expect((await send(subscriber.subscription, filler(MAX_PUSH_PAYLOAD_BYTES))).kind).toBe('ok');
    expect(service.requests).toHaveLength(1);
  });

  it('counts payload bytes, not characters', async () => {
    const send = createPushSender({ vapid, fetch: createFakePushService().fetch });
    expect((await send(subscriber.subscription, { x: '€'.repeat(1200) })).kind).toBe('rejected');
  });

  it.each([
    [{ ttl: -1 }, 'invalid-ttl'],
    [{ ttl: 1.5 }, 'invalid-ttl'],
    [{ ttl: 29 * 24 * 3600 }, 'invalid-ttl'],
    [{ urgency: 'urgent' as never }, 'invalid-urgency'],
    [{ topic: 'has space' }, 'invalid-topic'],
    [{ topic: 'x'.repeat(33) }, 'invalid-topic'],
  ])('rejects the options %j', async (options, reason) => {
    const service = createFakePushService();
    expect(await createPushSender({ vapid, fetch: service.fetch })(subscriber.subscription, PAYLOAD, options)).toEqual({ kind: 'rejected', reason });
    expect(service.requests).toHaveLength(0);
  });

  it('rejects subscription keys that cannot encrypt', async () => {
    const service = createFakePushService();
    const result = await createPushSender({ vapid, fetch: service.fetch })({ endpoint: subscriber.subscription.endpoint, keys: { p256dh: 'AAAA', auth: 'AAAA' } }, PAYLOAD);
    expect(result).toEqual({ kind: 'rejected', reason: 'invalid-subscription-keys' });
  });

  it('rejects every send when the VAPID keys are unusable, without a request', async () => {
    const service = createFakePushService();
    const other = await generateVapidKeys();
    const send = createPushSender({ vapid: { ...vapid, privateKey: other.privateKey }, fetch: service.fetch });
    expect(await send(subscriber.subscription, PAYLOAD)).toEqual({ kind: 'rejected', reason: 'vapid-not-usable' });
    expect(await send(subscriber.subscription, PAYLOAD)).toEqual({ kind: 'rejected', reason: 'vapid-not-usable' });
    expect(service.requests).toHaveLength(0);
  });
});

describe('logging', () => {
  it('logs the host and the status only: no key, endpoint path, payload or token', async () => {
    const lines: string[] = [];
    const record = (message: string, fields?: Record<string, unknown>) => void lines.push(JSON.stringify({ message, ...fields }));
    const logger = { debug: record, info: record, warn: record, error: record, appendKeys: () => undefined, removeKeys: () => undefined, createChild: () => logger } as Logger;
    setLogger(logger);
    try {
      const service = createFakePushService();
      const send = createPushSender({ vapid, fetch: service.fetch });
      await send(subscriber.subscription, PAYLOAD);
      service.respond(subscriber.subscription.endpoint, 410);
      await send(subscriber.subscription, PAYLOAD);
      service.fail(subscriber.subscription.endpoint);
      await send(subscriber.subscription, PAYLOAD);
      await createPushSender({ vapid: { ...vapid, privateKey: 'broken' }, fetch: service.fetch })(subscriber.subscription, PAYLOAD);
    } finally {
      setLogger({ ...logger, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined });
    }
    const output = lines.join('\n');
    expect(output).toContain('fcm.googleapis.com');
    for (const secret of [vapid.privateKey, vapid.publicKey, subscriber.subscription.keys.auth, subscriber.subscription.keys.p256dh, '/fcm/send/device-1', 'KMB declared', 'vapid t=']) {
      expect(output).not.toContain(secret);
    }
  });
});

describe('mapPushStatus and parseRetryAfter', () => {
  it('reads Retry-After as seconds or as an HTTP date', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter(' 30 ', NOW)).toBe(30);
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90);
    expect(parseRetryAfter(new Date(NOW - 90_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
  });

  it('omits retryAfterSeconds when the 429 does not say', () => {
    expect(mapPushStatus(429, null, NOW)).toEqual({ kind: 'rate-limited', status: 429 });
    expect(mapPushStatus(408, null, NOW)).toEqual({ kind: 'retryable', reason: 'push-service-error', status: 408 });
  });
});
