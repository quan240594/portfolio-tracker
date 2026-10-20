import { describe, expect, it } from 'vitest';
import {
  MAX_NOTIFICATION_LABEL,
  NOTIFICATIONS_ROUTES,
  cleanDeviceLabel,
  defaultNotificationSettings,
  isQuietHour,
  localDayAndHour,
  notificationKeys,
  settingsPatchSchema,
  subscribeBodySchema,
  testBodySchema,
} from './notifications.js';

const P256DH = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);

describe('keys and routes', () => {
  it('stores everything under the user partition', () => {
    expect(notificationKeys.subscription('u1', 'abc')).toEqual({ PK: 'USER#u1', SK: 'PUSHSUB#abc' });
    expect(notificationKeys.settings('u1')).toEqual({ PK: 'USER#u1', SK: 'NOTIFYSETTINGS' });
    expect(notificationKeys.notified('u1', 'declared', 'KMB', '2026-11-06')).toEqual({ PK: 'USER#u1', SK: 'NOTIFIED#declared#KMB#2026-11-06' });
    expect(notificationKeys.notified('u1', 'received', 'KMB', 'tx-1').SK.startsWith(notificationKeys.notifiedPrefix)).toBe(true);
    expect(notificationKeys.subscription('u1', 'abc').SK.startsWith(notificationKeys.subscriptionPrefix)).toBe(true);
  });

  it('declares five routes', () => {
    expect(Object.values(NOTIFICATIONS_ROUTES)).toEqual(['GET /notifications', 'PUT /notifications/settings', 'POST /notifications/subscriptions', 'DELETE /notifications/subscriptions/{id}', 'POST /notifications/test']);
  });

  it('defaults to every type on and two days before', () => {
    expect(defaultNotificationSettings()).toEqual({ types: { exDividend: true, declared: true, received: true }, exDividendDaysBefore: 2 });
    expect(defaultNotificationSettings()).not.toBe(defaultNotificationSettings());
  });
});

describe('request schemas', () => {
  it('accepts a subscription and rejects malformed keys', () => {
    expect(subscribeBodySchema.safeParse({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: P256DH, auth: AUTH }, label: 'Pixel' }).success).toBe(true);
    expect(subscribeBodySchema.safeParse({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'short', auth: AUTH } }).success).toBe(false);
    expect(subscribeBodySchema.safeParse({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: P256DH, auth: 'x' } }).success).toBe(false);
    expect(subscribeBodySchema.safeParse({ endpoint: '', keys: { p256dh: P256DH, auth: AUTH } }).success).toBe(false);
    expect(subscribeBodySchema.safeParse({ keys: { p256dh: P256DH, auth: AUTH } }).success).toBe(false);
  });

  it('accepts partial settings within the 1..5 day range and nothing else', () => {
    expect(settingsPatchSchema.safeParse({}).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ types: { received: false }, exDividendDaysBefore: 5 }).success).toBe(true);
    for (const bad of [{ exDividendDaysBefore: 0 }, { exDividendDaysBefore: 6 }, { exDividendDaysBefore: 1.5 }, { types: { other: true } }, { quiet: true }, { types: { received: 'no' } }]) {
      expect(settingsPatchSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('accepts a device id for the test or nothing', () => {
    expect(testBodySchema.safeParse({}).success).toBe(true);
    expect(testBodySchema.safeParse({ subscriptionId: 'a'.repeat(32) }).success).toBe(true);
    expect(testBodySchema.safeParse({ subscriptionId: 'nope' }).success).toBe(false);
  });
});

describe('cleanDeviceLabel', () => {
  it('trims, strips control characters and caps the length', () => {
    expect(cleanDeviceLabel('  Pixel 8  ')).toBe('Pixel 8');
    expect(cleanDeviceLabel('Pi\u0000xel\n8')).toBe('Pi xel 8');
    expect(cleanDeviceLabel('x'.repeat(100))).toHaveLength(MAX_NOTIFICATION_LABEL);
  });

  it('falls back to a default', () => {
    expect(cleanDeviceLabel(undefined)).toBe('This device');
    expect(cleanDeviceLabel('   \n ')).toBe('This device');
  });
});

describe('time', () => {
  it('reads the Amsterdam day and hour of an instant, summer and winter time', () => {
    expect(localDayAndHour(new Date('2026-07-01T07:30:00Z'))).toEqual({ day: '2026-07-01', hour: 9 });
    expect(localDayAndHour(new Date('2026-01-15T07:30:00Z'))).toEqual({ day: '2026-01-15', hour: 8 });
    expect(localDayAndHour(new Date('2026-07-01T22:30:00Z'))).toEqual({ day: '2026-07-02', hour: 0 });
    expect(localDayAndHour(new Date('2026-10-25T00:30:00Z'), 'UTC')).toEqual({ day: '2026-10-25', hour: 0 });
  });

  it('is quiet from 22:00 up to 08:00', () => {
    expect([21, 22, 23, 0, 7, 8, 9].map(isQuietHour)).toEqual([false, true, true, true, true, false, false]);
  });
});
