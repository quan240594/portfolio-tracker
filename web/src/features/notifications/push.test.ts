import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPushEnvironment, TEST_ENDPOINT, type PushEnvironment } from '../../test/pushEnvironment';
import {
  PERMISSION_DENIED_MESSAGE,
  PushPermissionError,
  currentSubscription,
  detectPushSupport,
  deviceLabel,
  disableOnThisDevice,
  enableOnThisDevice,
  endpointId,
  permissionState,
  registerPushWorker,
  serviceWorkerUrl,
  shouldRegisterPushWorker,
  urlBase64ToBytes,
} from './push';

let environment: PushEnvironment | undefined;
const install = (options?: Parameters<typeof installPushEnvironment>[0]) => (environment = installPushEnvironment(options));
afterEach(() => {
  environment?.restore();
  environment = undefined;
});

describe('detectPushSupport', () => {
  it('is supported with a secure context, service workers, the Push API and notifications', () => {
    install();
    expect(detectPushSupport()).toEqual({ supported: true });
  });

  it.each([
    ['no service workers', { noServiceWorker: true }, 'no-service-worker'],
    ['no Push API (iOS outside a Home Screen app)', { noPushManager: true }, 'no-push'],
  ])('is not supported with %s', (_label, options, reason) => {
    install(options);
    expect(detectPushSupport()).toEqual({ supported: false, reason });
  });

  it('is not supported without Notification, or in an insecure context', () => {
    install();
    expect(detectPushSupport({ isSecureContext: true, navigator: { serviceWorker: {} } as unknown as Navigator, PushManager: class {} })).toEqual({ supported: false, reason: 'no-notification' });
    expect(detectPushSupport({ isSecureContext: false, navigator, PushManager: class {}, Notification: class {} })).toEqual({ supported: false, reason: 'insecure' });
  });
});

describe('permissionState', () => {
  it('reports the browser permission, or unsupported', () => {
    install({ permission: 'denied' });
    expect(permissionState()).toBe('denied');
    environment!.restore();
    Reflect.deleteProperty(globalThis, 'Notification');
    expect(permissionState()).toBe('unsupported');
  });
});

describe('helpers', () => {
  it('decodes the VAPID key from base64url', () => {
    expect([...urlBase64ToBytes('AQID')]).toEqual([1, 2, 3]);
    expect([...urlBase64ToBytes('-_8')]).toEqual([251, 255]);
    expect(urlBase64ToBytes('B'.repeat(87))).toHaveLength(65);
  });

  it('names a device by the SHA-256 prefix of its endpoint, the way the server does', async () => {
    expect(await endpointId('abc')).toBe('ba7816bf8f01cfea414140de5dae2223');
  });

  it('labels the device from the user agent', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36 Edg/120.0')).toBe('Edge on Windows');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Safari/604.1')).toBe('Safari on iPhone');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0')).toBe('Firefox on Linux');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)')).toBe('macOS');
    expect(deviceLabel('curl/8')).toBe('This device');
    expect(deviceLabel('Chrome')).toBe('Chrome');
    expect(deviceLabel()).toEqual(expect.any(String));
  });

  it('registers the service worker only for the personal (GitHub) deployment, never in demo mode', () => {
    expect(shouldRegisterPushWorker('github', false)).toBe(true);
    expect(shouldRegisterPushWorker('github', true)).toBe(false);
    expect(shouldRegisterPushWorker('cognito', false)).toBe(false);
    expect(shouldRegisterPushWorker('none', false)).toBe(false);
  });
});

describe('the service worker', () => {
  it('is registered from sw.js under the app base path', async () => {
    const env = install();
    expect(serviceWorkerUrl()).toBe('/sw.js');
    expect(await registerPushWorker()).toBe(env.registration);
    expect(env.serviceWorker.register).toHaveBeenCalledWith('/sw.js');
  });

  it('is not registered where push is unsupported, and a failed registration is swallowed', async () => {
    install({ noPushManager: true });
    expect(await registerPushWorker()).toBeUndefined();
    environment!.restore();
    const env = install();
    env.serviceWorker.register.mockRejectedValueOnce(new Error('blocked'));
    expect(await registerPushWorker()).toBeUndefined();
  });
});

describe('currentSubscription', () => {
  it('finds this browser’s subscription, or none', async () => {
    const env = install({ subscribed: true });
    expect(await currentSubscription()).toBe(env.subscription);
    environment!.restore();
    install({ subscribed: false });
    expect(await currentSubscription()).toBeNull();
    environment!.restore();
    const none = install();
    none.serviceWorker.getRegistration.mockResolvedValueOnce(undefined);
    expect(await currentSubscription()).toBeNull();
    environment!.restore();
    install({ noPushManager: true });
    expect(await currentSubscription()).toBeNull();
  });
});

describe('enableOnThisDevice', () => {
  const KEY = 'B'.repeat(87);

  it('asks for permission first, registers the worker and subscribes with the server key', async () => {
    const env = install();
    const order: string[] = [];
    env.requestPermission.mockImplementation(() => {
      order.push('permission');
      return Promise.resolve('granted');
    });
    env.registration.pushManager.subscribe.mockImplementation(() => {
      order.push('subscribe');
      return Promise.resolve(env.subscription);
    });
    expect(await enableOnThisDevice(KEY)).toEqual({ endpoint: TEST_ENDPOINT, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
    expect(order).toEqual(['permission', 'subscribe']);
    const options = env.registration.pushManager.subscribe.mock.calls[0]![0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(options.userVisibleOnly).toBe(true);
    expect([...options.applicationServerKey]).toEqual([...urlBase64ToBytes(KEY)]);
    expect(env.serviceWorker.register).toHaveBeenCalledWith('/sw.js');
  });

  it('reuses an existing subscription', async () => {
    const env = install({ subscribed: true });
    await enableOnThisDevice(KEY);
    expect(env.registration.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it.each([['denied'], ['default']] as const)('never subscribes when the permission is %s', async (prompt) => {
    const env = install({ prompt });
    const attempt = enableOnThisDevice(KEY);
    await expect(attempt).rejects.toBeInstanceOf(PushPermissionError);
    await expect(attempt).rejects.toMatchObject({ permission: prompt });
    expect(env.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(env.serviceWorker.register).not.toHaveBeenCalled();
  });

  it('explains how to re-enable a blocked site in Chrome', async () => {
    install({ prompt: 'denied' });
    await expect(enableOnThisDevice(KEY)).rejects.toThrow(PERMISSION_DENIED_MESSAGE);
    expect(PERMISSION_DENIED_MESSAGE).toMatch(/lock icon.*Permissions.*Notifications.*Allow/);
  });

  it('refuses an incomplete subscription', async () => {
    const env = install();
    env.subscription.toJSON = () => ({ endpoint: TEST_ENDPOINT });
    await expect(enableOnThisDevice(KEY)).rejects.toThrow('incomplete');
  });
});

describe('disableOnThisDevice', () => {
  it('unsubscribes this browser', async () => {
    const env = install({ subscribed: true });
    expect(await disableOnThisDevice()).toBe(true);
    expect(env.subscription.unsubscribe).toHaveBeenCalled();
  });

  it('does nothing without a subscription', async () => {
    install();
    expect(await disableOnThisDevice()).toBe(false);
  });
});

vi.restoreAllMocks();
