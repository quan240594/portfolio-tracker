import { DEFAULT_PUSH_HOSTS, generateVapidKeys } from '@portfolio/platform';
import { createFakePushService, createTestSubscriber, verifyVapidAuthorization } from '@portfolio/platform/testing';
import { describe, expect, it } from 'vitest';
import { ORIGIN } from '../test/fakes.js';
import type { HubConfig } from './config.js';
import { pushConfig } from './push.js';
import { vapidInstructions } from './vapid-instructions.js';

const config = (push: HubConfig['push']): HubConfig => ({ secretsKey: 'k', origin: ORIGIN, baseCurrency: 'EUR', brokerSecretPrefix: '/x', symbolOverrides: {}, prices: {} as never, push });

describe('pushConfig', () => {
  it('is off without both keys', async () => {
    const keys = await generateVapidKeys();
    expect(pushConfig(config({ allowedHosts: DEFAULT_PUSH_HOSTS }), fetch)).toEqual({ configured: false });
    expect(pushConfig(config({ publicKey: keys.publicKey, allowedHosts: DEFAULT_PUSH_HOSTS }), fetch)).toEqual({ configured: false });
    expect(pushConfig(config({ privateKey: keys.privateKey, allowedHosts: DEFAULT_PUSH_HOSTS }), fetch)).toEqual({ configured: false });
  });

  it('is on with both: the public key for the browser, a sender that signs with the app origin as subject', async () => {
    const keys = await generateVapidKeys();
    const service = createFakePushService();
    const push = pushConfig(config({ ...keys, allowedHosts: DEFAULT_PUSH_HOSTS }), service.fetch);
    expect(push).toMatchObject({ configured: true, publicKey: keys.publicKey, allowedHosts: DEFAULT_PUSH_HOSTS });
    if (!push.configured) throw new Error('unreachable');
    const device = await createTestSubscriber();
    expect(await push.send(device.subscription, { title: 't' })).toEqual({ kind: 'ok', status: 201 });
    const { claims } = await verifyVapidAuthorization(service.requests[0]!.headers.Authorization!);
    expect(claims.sub).toBe(ORIGIN);
  });

  it('rejects every push when the keys do not belong together, without a request', async () => {
    const [a, b] = await Promise.all([generateVapidKeys(), generateVapidKeys()]);
    const service = createFakePushService();
    const push = pushConfig(config({ publicKey: a.publicKey, privateKey: b.privateKey, allowedHosts: DEFAULT_PUSH_HOSTS }), service.fetch);
    if (!push.configured) throw new Error('unreachable');
    expect(await push.send((await createTestSubscriber()).subscription, {})).toEqual({ kind: 'rejected', reason: 'vapid-not-usable' });
    expect(service.requests).toHaveLength(0);
  });
});

describe('vapidInstructions', () => {
  it('prints both keys once and the commands for the owner', async () => {
    const keys = await generateVapidKeys();
    const text = vapidInstructions(keys);
    expect(text.split(keys.publicKey)).toHaveLength(2);
    expect(text.split(keys.privateKey)).toHaveLength(2);
    expect(text).toContain('wrangler secret put VAPID_PRIVATE_KEY');
    expect(text).toContain('VAPID_PUBLIC_KEY=');
    expect(text).toContain('deploy:app');
  });
});
