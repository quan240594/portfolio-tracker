import { PushCryptoError, decodeUserAgentKeys, endpointId, validatePushEndpoint, type PushResult } from '@portfolio/platform';
import {
  MAX_PUSH_DEVICES,
  NOTIFICATION_TYPES,
  TEST_NOTIFICATION,
  cleanDeviceLabel,
  defaultNotificationSettings,
  settingsPatchSchema,
  subscribeBodySchema,
  testBodySchema,
  type NOTIFICATIONS_ROUTES,
  type NotificationSettings,
  type NotificationSettingsItem,
  type NotificationType,
  type NotificationsResponse,
  type PushDeviceSummary,
  type PushSubscriptionItem,
  type SubscribeResponse,
  type TestDeviceResult,
  type TestNotificationResponse,
} from '@portfolio/shared';
import type { RouteContext } from '../deps.js';
import { HttpError, ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import type { ConfiguredPush, NotifyDeps } from '../notifications/deps.js';
import { baselineUser } from '../notifications/data.js';
import type { RouteHandler } from '../router.js';

const DEVICE_ID = /^[0-9a-f]{32}$/;
const TEST_TTL_SECONDS = 300;

function requireNotify(ctx: RouteContext): NotifyDeps {
  if (!ctx.deps.notify) throw new HttpError(404, 'NOT_AVAILABLE', 'Notifications are not available on this deployment');
  return ctx.deps.notify;
}

/** Notifications that also need the push sender: without VAPID keys the browser cannot subscribe and nothing can be sent. */
function requirePush(ctx: RouteContext): { notify: NotifyDeps; push: ConfiguredPush } {
  const notify = requireNotify(ctx);
  if (!notify.push.configured) throw new HttpError(503, 'PUSH_NOT_CONFIGURED', 'Push notifications are not configured on the server (VAPID keys are missing)');
  return { notify, push: notify.push };
}

const settingsOf = (item: NotificationSettingsItem | null): NotificationSettings => {
  const defaults = defaultNotificationSettings();
  return item ? { types: { ...defaults.types, ...item.types }, exDividendDaysBefore: item.exDividendDaysBefore ?? defaults.exDividendDaysBefore } : defaults;
};

function serviceHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
}

/** The browser sees a device without its endpoint and keys. */
export const toDeviceSummary = (device: PushSubscriptionItem): PushDeviceSummary => ({
  id: device.id,
  label: device.label,
  service: serviceHost(device.endpoint),
  createdAt: device.createdAt,
  ...(device.lastSuccessAt ? { lastSuccessAt: device.lastSuccessAt } : {}),
  failures: device.failures,
});

export async function getNotifications(ctx: RouteContext): Promise<RouteResult> {
  const { notify } = ctx.deps;
  if (!notify) {
    return ok({ available: false, configured: false, settings: defaultNotificationSettings(), devices: [], maxDevices: MAX_PUSH_DEVICES } satisfies NotificationsResponse);
  }
  const [settings, devices] = await Promise.all([notify.repo.getSettings(ctx.userId), notify.repo.listSubscriptions(ctx.userId)]);
  const body: NotificationsResponse = {
    available: true,
    configured: notify.push.configured,
    ...(notify.push.configured ? { publicKey: notify.push.publicKey } : {}),
    settings: settingsOf(settings),
    devices: [...devices].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(toDeviceSummary),
    maxDevices: MAX_PUSH_DEVICES,
  };
  return ok(body);
}

export async function putNotificationSettings(ctx: RouteContext): Promise<RouteResult> {
  const notify = requireNotify(ctx);
  const patch = validate(settingsPatchSchema.safeParse(parseJsonBody(ctx.body)), 'Invalid notification settings');
  const existing = await notify.repo.getSettings(ctx.userId);
  const before = settingsOf(existing);
  const after: NotificationSettings = {
    types: { ...before.types, ...patch.types },
    exDividendDaysBefore: patch.exDividendDaysBefore ?? before.exDividendDaysBefore,
  };
  const at = ctx.deps.now().toISOString();
  await notify.repo.putSettings({ ...after, userId: ctx.userId, createdAt: existing?.createdAt ?? at, updatedAt: at });
  // A type that is switched on again must not announce what happened while it was off.
  const enabled = NOTIFICATION_TYPES.filter((type: NotificationType) => !before.types[type] && after.types[type]);
  if (existing && enabled.length > 0 && (await notify.repo.listSubscriptions(ctx.userId)).length > 0) {
    await baselineUser(ctx.deps.repo, notify.repo, ctx.userId, ctx.deps.now(), enabled);
  }
  return ok(after);
}

export async function subscribeNotifications(ctx: RouteContext): Promise<RouteResult> {
  const { notify, push } = requirePush(ctx);
  const body = validate(subscribeBodySchema.safeParse(parseJsonBody(ctx.body)), 'Invalid push subscription');
  const endpoint = validatePushEndpoint(body.endpoint, push.allowedHosts);
  if (!endpoint.ok) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid push subscription', [{ path: ['endpoint'], message: endpoint.reason }]);
  try {
    decodeUserAgentKeys(body.keys);
  } catch (error) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid push subscription', [{ path: ['keys'], message: error instanceof PushCryptoError ? error.message : 'Invalid keys' }]);
  }
  const id = await endpointId(body.endpoint);
  const devices = await notify.repo.listSubscriptions(ctx.userId);
  const known = devices.find((device) => device.id === id);
  if (!known && devices.length >= MAX_PUSH_DEVICES) throw new HttpError(409, 'TOO_MANY_DEVICES', `At most ${MAX_PUSH_DEVICES} devices can receive notifications; remove one first`);

  const now = ctx.deps.now();
  const item: PushSubscriptionItem = {
    userId: ctx.userId,
    id,
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    label: cleanDeviceLabel(body.label),
    createdAt: known?.createdAt ?? now.toISOString(),
    failures: known?.failures ?? 0,
  };
  const created = await notify.repo.putSubscription(item);
  if (devices.length === 0) await enableForFirstDevice(ctx, notify);
  const stored = known ? { ...known, keys: item.keys, label: item.label, endpoint: item.endpoint } : item;
  return ok({ device: toDeviceSummary(stored), created } satisfies SubscribeResponse, created ? 201 : 200);
}

/** The first device switches the feature on: default settings (when none were saved) and a quiet start, no announcement of history. */
async function enableForFirstDevice(ctx: RouteContext, notify: NotifyDeps): Promise<void> {
  const existing = await notify.repo.getSettings(ctx.userId);
  const settings = settingsOf(existing);
  const at = ctx.deps.now().toISOString();
  if (!existing) await notify.repo.putSettings({ ...settings, userId: ctx.userId, createdAt: at, updatedAt: at });
  await ctx.deps.repo.registerUser(ctx.userId);
  await baselineUser(ctx.deps.repo, notify.repo, ctx.userId, ctx.deps.now(), NOTIFICATION_TYPES.filter((type) => settings.types[type]));
}

export async function unsubscribeNotifications(ctx: RouteContext): Promise<RouteResult> {
  const notify = requireNotify(ctx);
  const id = ctx.pathParams.id ?? '';
  if (!DEVICE_ID.test(id)) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid device id');
  if (!(await notify.repo.deleteSubscription(ctx.userId, id))) throw new HttpError(404, 'NOT_FOUND', 'Device not found');
  return ok(undefined, 204);
}

const removesDevice = (result: PushResult): boolean => result.kind === 'gone' || (result.kind === 'rejected' && result.reason === 'invalid-endpoint');

async function testDevice(ctx: RouteContext, notify: NotifyDeps, push: ConfiguredPush, device: PushSubscriptionItem): Promise<TestDeviceResult> {
  const result = await push.send({ endpoint: device.endpoint, keys: device.keys }, TEST_NOTIFICATION, { ttl: TEST_TTL_SECONDS, urgency: 'high' });
  const removed = removesDevice(result);
  const at = ctx.deps.now().toISOString();
  if (removed) await notify.repo.deleteSubscription(ctx.userId, device.id);
  else await notify.repo.recordDelivery(ctx.userId, device.id, result.kind === 'ok' ? 'success' : 'failure', at);
  return { id: device.id, label: device.label, result: result.kind, removed };
}

export async function testNotification(ctx: RouteContext): Promise<RouteResult> {
  const { notify, push } = requirePush(ctx);
  const { subscriptionId } = validate(testBodySchema.safeParse(ctx.body ? parseJsonBody(ctx.body) : {}), 'Invalid test request');
  const devices = (await notify.repo.listSubscriptions(ctx.userId)).filter((device) => subscriptionId === undefined || device.id === subscriptionId);
  if (devices.length === 0 && subscriptionId !== undefined) throw new HttpError(404, 'NOT_FOUND', 'Device not found');
  if (devices.length === 0) throw new HttpError(409, 'NO_DEVICES', 'No device is registered for notifications');
  const results = await Promise.all(devices.map((device) => testDevice(ctx, notify, push, device)));
  return ok({ results } satisfies TestNotificationResponse);
}

export const notificationsHandlers: Record<keyof typeof NOTIFICATIONS_ROUTES, RouteHandler> = {
  notificationsGet: getNotifications,
  notificationsSettingsPut: putNotificationSettings,
  notificationsSubscribe: subscribeNotifications,
  notificationsUnsubscribe: unsubscribeNotifications,
  notificationsTest: testNotification,
};
