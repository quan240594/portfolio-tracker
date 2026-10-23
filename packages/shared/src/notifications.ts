/**
 * Push notifications (dividends and earnings summaries): contracts shared by the API, the notification job and the web app.
 *
 * Items (all under `PK = USER#{userId}`, like every per-user entity):
 *
 * | Entity       | SK                                  | entityType            |
 * |--------------|-------------------------------------|-----------------------|
 * | Device       | PUSHSUB#{sha-256 hex of endpoint}   | PUSH_SUBSCRIPTION     |
 * | Settings     | NOTIFYSETTINGS                      | NOTIFICATION_SETTINGS |
 * | Ledger entry | NOTIFIED#{type}#{symbol}#{eventKey} | NOTIFIED              |
 *
 * Routes (authenticated, same-origin; `available: false` on a deployment that has no push sender, e.g. the AWS demo):
 *
 * - GET    /notifications                  settings, devices (no endpoints or keys), `available`, `configured`, the VAPID public key
 * - PUT    /notifications/settings         partial update of the types and the ex-dividend lead time
 * - POST   /notifications/subscriptions    register this browser (SSRF-checked, at most 10 devices); idempotent per endpoint
 * - DELETE /notifications/subscriptions/{id}
 * - POST   /notifications/test             `{subscriptionId?}`: a test push to one or every device, with the per-device result
 */
import { z } from 'zod';

export const NOTIFICATIONS_ROUTES = {
  notificationsGet: 'GET /notifications',
  notificationsSettingsPut: 'PUT /notifications/settings',
  notificationsSubscribe: 'POST /notifications/subscriptions',
  notificationsUnsubscribe: 'DELETE /notifications/subscriptions/{id}',
  notificationsTest: 'POST /notifications/test',
} as const;

export const NOTIFICATION_ENTITY = { subscription: 'PUSH_SUBSCRIPTION', settings: 'NOTIFICATION_SETTINGS', notified: 'NOTIFIED' } as const;

export const NOTIFICATION_TYPES = ['exDividend', 'declared', 'received', 'earnings'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_LABELS: Readonly<Record<NotificationType, string>> = {
  exDividend: 'Ex-dividend reminders',
  declared: 'New dividend declared',
  received: 'Dividend received',
  earnings: 'Earnings summary',
};

export const notificationKeys = {
  subscription: (userId: string, id: string) => ({ PK: `USER#${userId}`, SK: `PUSHSUB#${id}` }),
  subscriptionPrefix: 'PUSHSUB#',
  settings: (userId: string) => ({ PK: `USER#${userId}`, SK: 'NOTIFYSETTINGS' }),
  notified: (userId: string, type: NotificationType, symbol: string, eventKey: string) => ({ PK: `USER#${userId}`, SK: `NOTIFIED#${type}#${symbol}#${eventKey}` }),
  notifiedPrefix: 'NOTIFIED#',
} as const;

/** A user may register this many browsers. */
export const MAX_PUSH_DEVICES = 10;
/** Ledger entries older than this are pruned (an event is never relevant for longer). */
export const NOTIFIED_RETENTION_DAYS = 400;
/** A received dividend older than this is recorded as notified without a push (a back-dated import must not flood the phone). */
export const RECEIVED_FRESH_DAYS = 14;
export const MAX_NOTIFICATION_LABEL = 40;

export const NOTIFICATION_TIME_ZONE = 'Europe/Amsterdam';
/** No push between 22:00 (inclusive) and 08:00 (exclusive) Amsterdam time. */
export const QUIET_HOURS = { startHour: 22, endHour: 8 } as const;

export const MIN_EX_DIVIDEND_DAYS = 1;
export const MAX_EX_DIVIDEND_DAYS = 5;
export const DEFAULT_EX_DIVIDEND_DAYS = 2;

export interface NotificationSettings {
  types: Record<NotificationType, boolean>;
  /** The ex-dividend reminder goes out this many days (1..5) before the ex-date. */
  exDividendDaysBefore: number;
}

export const defaultNotificationSettings = (): NotificationSettings => ({
  types: { exDividend: true, declared: true, received: true, earnings: true },
  exDividendDaysBefore: DEFAULT_EX_DIVIDEND_DAYS,
});

/** The settings in force: stored ones over the defaults, so a type added later (earnings) is on for users who saved their settings before it existed. */
export function effectiveNotificationSettings(stored: Partial<{ types: Partial<Record<NotificationType, boolean>>; exDividendDaysBefore: number }> | null | undefined): NotificationSettings {
  const defaults = defaultNotificationSettings();
  return { types: { ...defaults.types, ...stored?.types }, exDividendDaysBefore: stored?.exDividendDaysBefore ?? defaults.exDividendDaysBefore };
}

export interface NotificationSettingsItem extends NotificationSettings {
  userId: string;
  createdAt: string;
  updatedAt: string;
}

/** One browser/device. `endpoint` and `keys` never leave the server (see `PushDeviceSummary`). */
export interface PushSubscriptionItem {
  userId: string;
  /** SHA-256 (hex, 32 characters) of the endpoint. */
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label: string;
  createdAt: string;
  lastSuccessAt?: string;
  /** Consecutive failed deliveries; reset by a delivery. */
  failures: number;
  lastFailureAt?: string;
}

export interface NotifiedItem {
  userId: string;
  type: NotificationType;
  symbol: string;
  eventKey: string;
  notifiedAt: string;
  /** True when the entry was written without a push (baseline or a stale back-dated payment). */
  silent?: true;
}

/** The push message body that the service worker shows (end-to-end encrypted to the device). */
export interface PushNotificationPayload {
  type: NotificationType | 'summary' | 'test';
  symbol: string;
  title: string;
  body: string;
  /** Path inside the app that a tap opens. */
  url: string;
  /** Notifications with the same tag replace each other on the device. */
  tag: string;
}

// --- API ---------------------------------------------------------------------------------------------------------

const BASE64URL_P256DH = /^[A-Za-z0-9_-]{87}$/;
const BASE64URL_AUTH = /^[A-Za-z0-9_-]{22}$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what a label must not contain
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** A device label from the client: control characters removed, trimmed and cut to 40 characters; empty becomes "This device". */
export function cleanDeviceLabel(label: string | undefined): string {
  const cleaned = (label ?? '').replaceAll(CONTROL_CHARACTERS, ' ').trim().slice(0, MAX_NOTIFICATION_LABEL).trim();
  return cleaned === '' ? 'This device' : cleaned;
}

export const subscribeBodySchema = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: z.string().regex(BASE64URL_P256DH, 'p256dh must be a base64url P-256 public key'), auth: z.string().regex(BASE64URL_AUTH, 'auth must be a base64url 16-byte secret') }),
  label: z.string().max(200).optional(),
});
export type SubscribeBody = z.infer<typeof subscribeBodySchema>;

export const settingsPatchSchema = z
  .object({
    types: z.object({ exDividend: z.boolean(), declared: z.boolean(), received: z.boolean(), earnings: z.boolean() }).partial().strict().optional(),
    exDividendDaysBefore: z.number().int().min(MIN_EX_DIVIDEND_DAYS).max(MAX_EX_DIVIDEND_DAYS).optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const testBodySchema = z.object({ subscriptionId: z.string().regex(/^[0-9a-f]{32}$/).optional() }).strict();

/** What the API tells the browser about a device: never the endpoint or the keys. */
export interface PushDeviceSummary {
  id: string;
  label: string;
  /** Host of the push service (e.g. `fcm.googleapis.com`). */
  service: string;
  createdAt: string;
  lastSuccessAt?: string;
  failures: number;
}

export interface NotificationsResponse {
  /** False on a deployment without a push sender (the AWS demo): the app hides the feature. */
  available: boolean;
  /** False until `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set on the server. */
  configured: boolean;
  /** The `applicationServerKey` for `pushManager.subscribe` (only when configured). */
  publicKey?: string;
  settings: NotificationSettings;
  devices: PushDeviceSummary[];
  maxDevices: number;
}

export interface SubscribeResponse {
  device: PushDeviceSummary;
  /** True when this call created the device (false: an existing endpoint was refreshed). */
  created: boolean;
}

export const TEST_RESULT_KINDS = ['ok', 'gone', 'rate-limited', 'retryable', 'rejected'] as const;

export interface TestDeviceResult {
  id: string;
  label: string;
  result: (typeof TEST_RESULT_KINDS)[number];
  /** True when the push service reported the device unsubscribed and the server removed it. */
  removed: boolean;
}

export interface TestNotificationResponse {
  results: TestDeviceResult[];
}

// --- Time -----------------------------------------------------------------------------------------------------------

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** Local calendar day (`YYYY-MM-DD`) and hour (0-23) of an instant in a time zone (default Amsterdam). */
export function localDayAndHour(instant: Date, timeZone: string = NOTIFICATION_TIME_ZONE): { day: string; hour: number } {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
    zoneFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Quiet hours: 22:00 up to (not including) 08:00 local time. */
export const isQuietHour = (hour: number): boolean => hour >= QUIET_HOURS.startHour || hour < QUIET_HOURS.endHour;
