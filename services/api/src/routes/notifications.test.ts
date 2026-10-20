import { endpointId } from '@portfolio/platform';
import { createTestSubscriber } from '@portfolio/platform/testing';
import { MAX_PUSH_DEVICES, drain, notificationKeys, sequentially, type NotificationsResponse } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { createHandler } from '../lambda/handler.js';
import { apiEvent, fakeDeps, fakeNotifyDeps, txn } from '../testing/fakes.js';

const USER = 'demo';

function setup(options: Parameters<typeof fakeNotifyDeps>[0] | 'none' = {}) {
  const notify = options === 'none' ? undefined : fakeNotifyDeps(options);
  const ctx = fakeDeps(notify ? { notify: notify.notify } : {});
  const handler = createHandler(() => ctx.deps);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handler(apiEvent(method, path, { body }));
    return { status: res.statusCode ?? 0, body: res.body ? JSON.parse(res.body) : undefined };
  };
  const subscribe = async (name: string, label?: string) => {
    const subscriber = await createTestSubscriber(`https://fcm.googleapis.com/fcm/send/${name}`);
    const response = await call('POST', '/notifications/subscriptions', { ...subscriber.subscription, ...(label ? { label } : {}) });
    return { subscriber, response };
  };
  const sent = notify?.sent ?? [];
  const answer = notify?.answer ?? { current: { kind: 'ok', status: 201 } };
  return { ...ctx, notify, call, subscribe, sent, answer };
}

describe('GET /notifications', () => {
  it('says the feature is unavailable without a notification sender (AWS) and answers the write routes with 404', async () => {
    const { call } = setup('none');
    const response = await call('GET', '/notifications');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ available: false, configured: false, devices: [], maxDevices: MAX_PUSH_DEVICES });
    expect(response.body.publicKey).toBeUndefined();
    for (const [method, path, body] of [['PUT', '/notifications/settings', {}], ['POST', '/notifications/subscriptions', {}], ['POST', '/notifications/test', undefined], ['DELETE', `/notifications/subscriptions/${'a'.repeat(32)}`, undefined]] as const) {
      const result = await call(method, path, body);
      expect([result.status, result.body.error.code]).toEqual([404, 'NOT_AVAILABLE']);
    }
  });

  it('reports the defaults, no devices and the public key', async () => {
    const { call } = setup();
    const { body } = (await call('GET', '/notifications')) as { body: NotificationsResponse };
    expect(body).toEqual({
      available: true,
      configured: true,
      publicKey: 'B'.repeat(87),
      settings: { types: { exDividend: true, declared: true, received: true }, exDividendDaysBefore: 2 },
      devices: [],
      maxDevices: MAX_PUSH_DEVICES,
    });
  });

  it('is available but not configured without VAPID keys: no public key, subscribing and testing say so', async () => {
    const { call } = setup({ configured: false });
    const state = await call('GET', '/notifications');
    expect(state.body).toMatchObject({ available: true, configured: false });
    expect(state.body.publicKey).toBeUndefined();
    const subscriber = await createTestSubscriber();
    for (const result of [await call('POST', '/notifications/subscriptions', subscriber.subscription), await call('POST', '/notifications/test')]) {
      expect([result.status, result.body.error.code]).toEqual([503, 'PUSH_NOT_CONFIGURED']);
    }
    expect((await call('PUT', '/notifications/settings', { exDividendDaysBefore: 3 })).status).toBe(200);
  });

  it('lists devices oldest first without the endpoint or the keys', async () => {
    const { call, subscribe, notify } = setup();
    const first = await subscribe('one', 'Pixel');
    await subscribe('two');
    const { devices } = (await call('GET', '/notifications')).body as NotificationsResponse;
    expect(devices.map((d) => d.label)).toEqual(['Pixel', 'This device']);
    expect(devices[0]).toEqual({ id: first.response.body.device.id, label: 'Pixel', service: 'fcm.googleapis.com', createdAt: '2026-06-15T12:00:00.000Z', failures: 0 });
    const serialized = JSON.stringify(devices);
    expect(serialized).not.toContain(first.subscriber.subscription.keys.auth);
    expect(serialized).not.toContain('/fcm/send/');
    expect((await notify!.repo.listSubscriptions(USER))[0]!.endpoint).toBe('https://fcm.googleapis.com/fcm/send/one');
  });
});

describe('devices with a damaged endpoint', () => {
  it('are listed with an unknown service instead of failing the page', async () => {
    const { call, notify } = setup();
    await notify!.repo.putSubscription({ userId: USER, id: 'c'.repeat(32), endpoint: 'not a url', keys: { p256dh: 'p', auth: 'a' }, label: 'Broken', createdAt: '2026-06-15T12:00:00.000Z', failures: 0 });
    expect((await call('GET', '/notifications')).body.devices[0]).toMatchObject({ label: 'Broken', service: 'unknown' });
  });
});

describe('PUT /notifications/settings', () => {
  it('merges partial updates and persists them', async () => {
    const { call, notify } = setup();
    const response = await call('PUT', '/notifications/settings', { types: { declared: false }, exDividendDaysBefore: 5 });
    expect(response.body).toEqual({ types: { exDividend: true, declared: false, received: true }, exDividendDaysBefore: 5 });
    expect((await call('PUT', '/notifications/settings', { types: { received: false } })).body).toEqual({ types: { exDividend: true, declared: false, received: false }, exDividendDaysBefore: 5 });
    expect(await notify!.repo.getSettings(USER)).toMatchObject({ userId: USER, exDividendDaysBefore: 5, createdAt: '2026-06-15T12:00:00.000Z', updatedAt: '2026-06-15T12:00:00.000Z' });
    expect((await call('GET', '/notifications')).body.settings).toEqual({ types: { exDividend: true, declared: false, received: false }, exDividendDaysBefore: 5 });
  });

  it.each([[{ exDividendDaysBefore: 0 }], [{ exDividendDaysBefore: 6 }], [{ types: { received: 'yes' } }], [{ quietHours: { start: 1 } }], [{ types: { unknown: true } }]])('rejects %j', async (body) => {
    const { call } = setup();
    const response = await call('PUT', '/notifications/settings', body);
    expect([response.status, response.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
  });

  it('rejects a missing or malformed body', async () => {
    const { call, deps } = setup();
    expect((await call('PUT', '/notifications/settings')).status).toBe(400);
    const handler = createHandler(() => deps);
    expect((await handler({ ...apiEvent('PUT', '/notifications/settings'), body: '{nope' })).statusCode).toBe(400);
  });

  it('switching a type on again marks what happened while it was off as notified', async () => {
    const { call, repo, subscribe, notify } = setup();
    repo.transactions = [txn({ id: 'buy', type: 'BUY', symbol: 'KMB', quantity: 5, price: 100, currency: 'USD', date: '2026-01-02' })];
    await call('PUT', '/notifications/settings', { types: { received: false } });
    await subscribe('phone');
    repo.transactions = [...repo.transactions, txn({ id: 'div-while-off', type: 'DIVIDEND', symbol: 'KMB', quantity: 5, price: 1.2, currency: 'USD', date: '2026-06-14' })];
    expect([...(await notify!.repo.listNotified(USER))]).toEqual([]);
    await call('PUT', '/notifications/settings', { types: { received: true } });
    expect([...(await notify!.repo.listNotified(USER))]).toEqual(['received#KMB#div-while-off']);
  });

  it('does not baseline when no device exists yet (the first device does)', async () => {
    const { call, repo, notify } = setup();
    repo.transactions = [txn({ id: 'div', type: 'DIVIDEND', symbol: 'KMB', quantity: 5, price: 1.2, currency: 'USD', date: '2026-06-14' })];
    await call('PUT', '/notifications/settings', { types: { received: false } });
    await call('PUT', '/notifications/settings', { types: { received: true } });
    expect([...(await notify!.repo.listNotified(USER))]).toEqual([]);
  });
});

describe('POST /notifications/subscriptions', () => {
  it('stores a device, hashes the endpoint into its id and cleans the label', async () => {
    const { subscribe, notify } = setup();
    const { subscriber, response } = await subscribe('phone', '  Pixel\n8  ');
    expect(response.status).toBe(201);
    const id = await endpointId(subscriber.subscription.endpoint);
    expect(response.body).toEqual({ created: true, device: { id, label: 'Pixel 8', service: 'fcm.googleapis.com', createdAt: '2026-06-15T12:00:00.000Z', failures: 0 } });
    expect(await notify!.store.get(notificationKeys.subscription(USER, id))).toMatchObject({
      entityType: 'PUSH_SUBSCRIPTION',
      userId: USER,
      id,
      endpoint: subscriber.subscription.endpoint,
      keys: subscriber.subscription.keys,
      label: 'Pixel 8',
      failures: 0,
    });
  });

  it('is idempotent per endpoint: the keys and label are refreshed, the device is not duplicated', async () => {
    const { call, notify } = setup();
    const first = await createTestSubscriber('https://fcm.googleapis.com/fcm/send/same');
    const created = await call('POST', '/notifications/subscriptions', { ...first.subscription, label: 'Old' });
    const rotated = await createTestSubscriber('https://fcm.googleapis.com/fcm/send/same');
    const refreshed = await call('POST', '/notifications/subscriptions', { ...rotated.subscription, label: 'New' });
    expect([created.status, refreshed.status, refreshed.body.created]).toEqual([201, 200, false]);
    expect(refreshed.body.device).toMatchObject({ id: created.body.device.id, label: 'New', createdAt: created.body.device.createdAt });
    const stored = await notify!.repo.listSubscriptions(USER);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ keys: rotated.subscription.keys, label: 'New' });
  });

  it('refuses an endpoint outside the push services before storing anything', async () => {
    const { call, notify } = setup();
    const { keys } = (await createTestSubscriber()).subscription;
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://example.com/x', 'https://169.254.169.254/latest', 'https://user@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'not a url']) {
      const response = await call('POST', '/notifications/subscriptions', { endpoint, keys });
      expect([response.status, response.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    }
    expect(await notify!.repo.listSubscriptions(USER)).toEqual([]);
  });

  it('honours the configured allow-list of the deployment', async () => {
    const ctx = fakeNotifyDeps();
    ctx.notify.push = { ...(ctx.notify.push as { configured: true; publicKey: string; send: never }), allowedHosts: ['push.example.org'] };
    const deps = fakeDeps({ notify: ctx.notify });
    const handler = createHandler(() => deps.deps);
    const subscriber = await createTestSubscriber('https://push.example.org/abc');
    expect((await handler(apiEvent('POST', '/notifications/subscriptions', { body: subscriber.subscription }))).statusCode).toBe(201);
    const other = await createTestSubscriber('https://fcm.googleapis.com/fcm/send/x');
    expect((await handler(apiEvent('POST', '/notifications/subscriptions', { body: other.subscription }))).statusCode).toBe(400);
  });

  it('refuses keys that are not a P-256 point and a 16-byte secret', async () => {
    const { call } = setup();
    const { subscription } = await createTestSubscriber();
    const notAPoint = 'A'.repeat(87);
    const bad = await call('POST', '/notifications/subscriptions', { endpoint: subscription.endpoint, keys: { p256dh: notAPoint, auth: subscription.keys.auth } });
    expect([bad.status, bad.body.error.details[0].path]).toEqual([400, ['keys']]);
    expect((await call('POST', '/notifications/subscriptions', { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: 'short' } })).status).toBe(400);
    expect((await call('POST', '/notifications/subscriptions', { keys: subscription.keys })).status).toBe(400);
  });

  it('allows ten devices and answers 409 for the eleventh, but still accepts a refresh of a known one', async () => {
    const { call, subscribe } = setup();
    const all: Awaited<ReturnType<typeof subscribe>>[] = [];
    await drain(sequentially(Array.from({ length: MAX_PUSH_DEVICES }, (_unused, index) => index), async (index) => {
          all.push(await subscribe(`d${index}`));
        }));
    expect(all.every((entry) => entry.response.status === 201)).toBe(true);
    const eleventh = await subscribe('d-extra');
    expect([eleventh.response.status, eleventh.response.body.error.code]).toEqual([409, 'TOO_MANY_DEVICES']);
    const refresh = await call('POST', '/notifications/subscriptions', all[0]!.subscriber.subscription);
    expect(refresh.status).toBe(200);
  });

  it('the first device switches notifications on: default settings, the user is registered, history is marked as notified, the reminder is not', async () => {
    const { subscribe, repo, notify } = setup();
    repo.transactions = [
      txn({ id: 'buy', type: 'BUY', symbol: 'KMB', quantity: 5, price: 100, currency: 'USD', date: '2026-01-02' }),
      txn({ id: 'old-div', type: 'DIVIDEND', symbol: 'KMB', quantity: 5, price: 1.2, currency: 'USD', date: '2026-03-02' }),
    ];
    repo.dividendEvents = [
      { symbol: 'KMB', exDate: '2026-06-17', payDate: '2026-07-02', amount: 1.3, currency: 'USD' },
      { symbol: 'KMB', exDate: '2026-03-01', payDate: '2026-03-02', amount: 1.2, currency: 'USD' },
    ];
    expect(await notify!.repo.getSettings(USER)).toBeNull();
    await subscribe('phone');
    expect(await notify!.repo.getSettings(USER)).toMatchObject({ types: { exDividend: true, declared: true, received: true }, exDividendDaysBefore: 2 });
    expect(repo.users.has(USER)).toBe(true);
    expect([...(await notify!.repo.listNotified(USER))].sort((a, b) => a.localeCompare(b))).toEqual(['declared#KMB#2026-06-17', 'received#KMB#old-div']);
    await subscribe('tablet');
    expect((await notify!.repo.listNotified(USER)).size).toBe(2);
  });

  it('keeps saved settings and only baselines the enabled types when the first device arrives', async () => {
    const { call, subscribe, repo, notify } = setup();
    repo.transactions = [txn({ id: 'div', type: 'DIVIDEND', symbol: 'KMB', quantity: 5, price: 1.2, currency: 'USD', date: '2026-03-02' })];
    await call('PUT', '/notifications/settings', { types: { received: false, declared: false } });
    await subscribe('phone');
    expect([...(await notify!.repo.listNotified(USER))]).toEqual([]);
    expect((await notify!.repo.getSettings(USER))!.types).toEqual({ exDividend: true, declared: false, received: false });
  });
});

describe('DELETE /notifications/subscriptions/{id}', () => {
  it('removes the device once', async () => {
    const { call, subscribe } = setup();
    const { response } = await subscribe('phone');
    const id = response.body.device.id as string;
    expect((await call('DELETE', `/notifications/subscriptions/${id}`)).status).toBe(204);
    expect((await call('DELETE', `/notifications/subscriptions/${id}`)).status).toBe(404);
    expect((await call('GET', '/notifications')).body.devices).toEqual([]);
  });

  it('rejects an id that is not a device id', async () => {
    const { call } = setup();
    expect((await call('DELETE', '/notifications/subscriptions/not-an-id')).status).toBe(400);
  });
});

describe('POST /notifications/test', () => {
  it('sends the test notification to every device and reports each result', async () => {
    const { call, subscribe, sent } = setup();
    const one = await subscribe('one', 'Pixel');
    const two = await subscribe('two', 'Tablet');
    const response = await call('POST', '/notifications/test');
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([
      { id: one.response.body.device.id, label: 'Pixel', result: 'ok', removed: false },
      { id: two.response.body.device.id, label: 'Tablet', result: 'ok', removed: false },
    ]);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.payload).toMatchObject({ type: 'test', title: 'Test notification', url: '/settings/notifications' });
    expect((await call('GET', '/notifications')).body.devices.map((d: { lastSuccessAt?: string }) => d.lastSuccessAt)).toEqual(['2026-06-15T12:00:00.000Z', '2026-06-15T12:00:00.000Z']);
  });

  it('can target one device', async () => {
    const { call, subscribe, sent } = setup();
    await subscribe('one');
    const two = await subscribe('two');
    const response = await call('POST', '/notifications/test', { subscriptionId: two.response.body.device.id });
    expect(response.body.results).toHaveLength(1);
    expect(sent.map((s) => s.subscription.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/two']);
  });

  it('removes a device the push service reports gone', async () => {
    const { call, subscribe, answer } = setup();
    await subscribe('one');
    answer.current = { kind: 'gone', status: 410 };
    const response = await call('POST', '/notifications/test');
    expect(response.body.results[0]).toMatchObject({ result: 'gone', removed: true });
    expect((await call('GET', '/notifications')).body.devices).toEqual([]);
  });

  it('removes a device whose endpoint stopped passing the SSRF check', async () => {
    const { call, subscribe, answer } = setup();
    await subscribe('one');
    answer.current = { kind: 'rejected', reason: 'invalid-endpoint' };
    expect((await call('POST', '/notifications/test')).body.results[0]).toMatchObject({ result: 'rejected', removed: true });
  });

  it.each([
    [{ kind: 'retryable', reason: 'timeout' } as const, 'retryable'],
    [{ kind: 'rate-limited', status: 429 } as const, 'rate-limited'],
    [{ kind: 'rejected', reason: 'refused', status: 403 } as const, 'rejected'],
  ])('keeps a device and counts the failure for %j', async (result, expected) => {
    const { call, subscribe, answer } = setup();
    await subscribe('one');
    answer.current = result;
    expect((await call('POST', '/notifications/test')).body.results[0]).toMatchObject({ result: expected, removed: false });
    expect((await call('GET', '/notifications')).body.devices[0].failures).toBe(1);
  });

  it('answers 404 for an unknown device, 409 when there is none, 400 for a malformed id', async () => {
    const { call, subscribe } = setup();
    expect((await call('POST', '/notifications/test')).body.error.code).toBe('NO_DEVICES');
    await subscribe('one');
    expect((await call('POST', '/notifications/test', { subscriptionId: 'f'.repeat(32) })).status).toBe(404);
    expect((await call('POST', '/notifications/test', { subscriptionId: 'x' })).status).toBe(400);
    expect((await call('POST', '/notifications/test', { other: 1 })).status).toBe(400);
  });
});

describe('isolation', () => {
  it('keeps every user to their own devices and settings', async () => {
    const { deps } = setup();
    const handler = createHandler(() => deps);
    const subscriber = await createTestSubscriber('https://fcm.googleapis.com/fcm/send/mine');
    await handler(apiEvent('POST', '/notifications/subscriptions', { body: subscriber.subscription, sub: 'user-a' }));
    // authMode 'demo' ignores `sub`: the demo user is used, so use the repository to prove the key layout instead
    const { notify } = setup();
    await notify!.repo.putSubscription({ userId: 'user-a', id: 'a'.repeat(32), endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' }, label: 'a', createdAt: 'x', failures: 0 });
    expect(await notify!.repo.listSubscriptions('user-b')).toEqual([]);
    expect(await notify!.repo.listSubscriptions('user-a')).toHaveLength(1);
  });
});
