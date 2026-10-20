import { vi } from 'vitest';

/** A stand-in for the browser's push stack (jsdom has none): service worker, Push API and Notification, all spies. */
export interface PushEnvironment {
  subscription: { endpoint: string; toJSON: () => unknown; unsubscribe: ReturnType<typeof vi.fn> };
  registration: { pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> } };
  serviceWorker: { register: ReturnType<typeof vi.fn>; getRegistration: ReturnType<typeof vi.fn>; ready: Promise<unknown> };
  requestPermission: ReturnType<typeof vi.fn>;
  restore: () => void;
}

export const TEST_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-device';
const P256DH = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);

interface Options {
  permission?: NotificationPermission;
  /** The permission the prompt resolves to. */
  prompt?: NotificationPermission;
  /** Start with this browser already subscribed. */
  subscribed?: boolean;
  /** Leave out `PushManager` (iOS Safari outside a Home Screen app). */
  noPushManager?: boolean;
  noServiceWorker?: boolean;
}

const original = {
  serviceWorker: Object.getOwnPropertyDescriptor(navigator, 'serviceWorker'),
  PushManager: Object.getOwnPropertyDescriptor(globalThis, 'PushManager'),
  Notification: Object.getOwnPropertyDescriptor(globalThis, 'Notification'),
};

function put(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

export function installPushEnvironment(options: Options = {}): PushEnvironment {
  const { permission = 'default', prompt = 'granted', subscribed = false, noPushManager = false, noServiceWorker = false } = options;
  // The browser remembers a subscription once made, until it is dropped.
  let active = subscribed;
  const subscription = {
    endpoint: TEST_ENDPOINT,
    toJSON: () => ({ endpoint: TEST_ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } }),
    unsubscribe: vi.fn(() => {
      active = false;
      return Promise.resolve(true);
    }),
  };
  const registration = {
    pushManager: {
      getSubscription: vi.fn(() => Promise.resolve(active ? subscription : null)),
      subscribe: vi.fn(() => {
        active = true;
        return Promise.resolve(subscription);
      }),
    },
  };
  const serviceWorker = { register: vi.fn(() => Promise.resolve(registration)), getRegistration: vi.fn(() => Promise.resolve(registration)), ready: Promise.resolve(registration) };
  const requestPermission = vi.fn(() => Promise.resolve(prompt));
  if (!noServiceWorker) Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true });
  else Reflect.deleteProperty(navigator, 'serviceWorker');
  if (noPushManager) Reflect.deleteProperty(globalThis, 'PushManager');
  else Object.defineProperty(globalThis, 'PushManager', { value: class PushManager {}, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Notification', { value: Object.assign(vi.fn(), { permission, requestPermission }), configurable: true, writable: true });
  return {
    subscription,
    registration,
    serviceWorker,
    requestPermission,
    restore: () => {
      put(navigator, 'serviceWorker', original.serviceWorker);
      put(globalThis, 'PushManager', original.PushManager);
      put(globalThis, 'Notification', original.Notification);
    },
  };
}
