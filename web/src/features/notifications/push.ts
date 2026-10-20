/** Browser side of Web Push: support detection, the permission prompt, the service worker and the push subscription. Nothing here runs unless the user clicks. */

export type PushUnsupportedReason = 'insecure' | 'no-service-worker' | 'no-push' | 'no-notification';
export type PushSupport = { supported: true } | { supported: false; reason: PushUnsupportedReason };
export type PermissionState = NotificationPermission | 'unsupported';

/** Everything push needs: a secure context, service workers, the Push API and notifications. */
export function detectPushSupport(scope: Pick<typeof globalThis, 'isSecureContext' | 'navigator'> & { PushManager?: unknown; Notification?: unknown } = globalThis): PushSupport {
  if (scope.isSecureContext === false) return { supported: false, reason: 'insecure' };
  if (!('serviceWorker' in scope.navigator)) return { supported: false, reason: 'no-service-worker' };
  if (scope.PushManager === undefined) return { supported: false, reason: 'no-push' };
  if (scope.Notification === undefined) return { supported: false, reason: 'no-notification' };
  return { supported: true };
}

export const UNSUPPORTED_MESSAGES: Readonly<Record<PushUnsupportedReason, string>> = {
  insecure: 'Notifications need a secure (https) connection.',
  'no-service-worker': 'This browser has no service workers, which push notifications need.',
  'no-push': 'This browser cannot receive push notifications. Use Chrome on Android; on an iPhone or iPad, first add this app to the Home Screen (Share, then Add to Home Screen) and open it from there.',
  'no-notification': 'This browser cannot show notifications. Use Chrome on Android; on an iPhone or iPad, first add this app to the Home Screen (Share, then Add to Home Screen) and open it from there.',
};

export const PERMISSION_DENIED_MESSAGE =
  'Notifications are blocked for this site. In Chrome, tap the lock icon next to the address, open Permissions (or Site settings), set Notifications to Allow and reload this page.';

export const permissionState = (): PermissionState => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/** The permission prompt was refused or dismissed: `permission` says which (`denied` blocks later prompts, `default` is a dismissal). */
export class PushPermissionError extends Error {
  constructor(readonly permission: NotificationPermission) {
    super(permission === 'denied' ? PERMISSION_DENIED_MESSAGE : 'Notifications were not allowed. Choose "Enable on this device" again and allow them when the browser asks.');
    this.name = 'PushPermissionError';
  }
}

/** The VAPID public key (base64url) as the bytes `pushManager.subscribe` wants. */
export function urlBase64ToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64Url.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.codePointAt(0)!);
}

/** The id the server gives a device: the first 128 bits of the SHA-256 of its endpoint, hex. Lets the page recognise "this device" without the server revealing endpoints. */
export async function endpointId(endpoint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `sw.js` next to index.html (Vite's base path, so a deployment under a sub-path works too). */
export const serviceWorkerUrl = (): string => `${import.meta.env.BASE_URL}sw.js`;

/** Registers the notification service worker (idempotent). Resolves undefined when the browser cannot. */
export async function registerPushWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!detectPushSupport().supported) return undefined;
  try {
    return await navigator.serviceWorker.register(serviceWorkerUrl());
  } catch {
    return undefined;
  }
}

/** The push subscription of this browser, if there is one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!detectPushSupport().supported) return null;
  const registration = await navigator.serviceWorker.getRegistration(serviceWorkerUrl());
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export interface DeviceSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function toDeviceSubscription(subscription: PushSubscription): DeviceSubscription {
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) throw new Error('The browser returned an incomplete push subscription.');
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/**
 * Asks for permission (this must run from a click) and subscribes this browser with the server's VAPID key. Throws `PushPermissionError`
 * when the permission is not granted; reuses an existing subscription for the same key.
 */
export async function enableOnThisDevice(publicKey: string): Promise<DeviceSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new PushPermissionError(permission);
  await navigator.serviceWorker.register(serviceWorkerUrl());
  const registration = await navigator.serviceWorker.ready;
  const subscription = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) }));
  return toDeviceSubscription(subscription);
}

/** Drops this browser's push subscription (the push service forgets it); resolves whether there was one. */
export async function disableOnThisDevice(): Promise<boolean> {
  const subscription = await currentSubscription();
  return subscription ? subscription.unsubscribe() : false;
}

/** A short device label such as "Chrome on Android" from the user agent (the server caps it at 40 characters). */
export function deviceLabel(userAgent: string = navigator.userAgent): string {
  const browser = [
    ['Edg', 'Edge'],
    ['Firefox', 'Firefox'],
    ['Chrome', 'Chrome'],
    ['Safari', 'Safari'],
  ].find(([token]) => userAgent.includes(token!))?.[1];
  const system = [
    ['Android', 'Android'],
    ['iPhone', 'iPhone'],
    ['iPad', 'iPad'],
    ['Windows', 'Windows'],
    ['Mac OS', 'macOS'],
    ['Linux', 'Linux'],
  ].find(([token]) => userAgent.includes(token!))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? 'This device';
}
