import { MemoryItemStore, registerUser } from '@portfolio/platform';
import { NOTIFIED_RETENTION_DAYS, notificationKeys, type PushSubscriptionItem } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { ItemNotificationRepository } from './repository.js';

const device = (overrides: Partial<PushSubscriptionItem> = {}): PushSubscriptionItem => ({
  userId: 'u1',
  id: 'a'.repeat(32),
  endpoint: 'https://fcm.googleapis.com/fcm/send/a',
  keys: { p256dh: 'p', auth: 'a' },
  label: 'Phone',
  createdAt: '2026-10-01T00:00:00.000Z',
  failures: 0,
  ...overrides,
});

describe('ItemNotificationRepository', () => {
  it('stores settings under USER#id / NOTIFYSETTINGS', async () => {
    const store = new MemoryItemStore();
    const repo = new ItemNotificationRepository(store);
    expect(await repo.getSettings('u1')).toBeNull();
    await repo.putSettings({ userId: 'u1', types: { exDividend: true, declared: false, received: true }, exDividendDaysBefore: 3, createdAt: 'c', updatedAt: 'u' });
    expect(await store.get(notificationKeys.settings('u1'))).toMatchObject({ PK: 'USER#u1', SK: 'NOTIFYSETTINGS', entityType: 'NOTIFICATION_SETTINGS', exDividendDaysBefore: 3 });
    expect(await repo.getSettings('u1')).toEqual({ userId: 'u1', types: { exDividend: true, declared: false, received: true }, exDividendDaysBefore: 3, createdAt: 'c', updatedAt: 'u' });
    expect(await repo.getSettings('u2')).toBeNull();
  });

  it('creates a device, and refreshes the keys and label of an existing one without touching its delivery record', async () => {
    const repo = new ItemNotificationRepository(new MemoryItemStore());
    expect(await repo.putSubscription(device())).toBe(true);
    await repo.recordDelivery('u1', device().id, 'failure', '2026-10-02T00:00:00.000Z');
    expect(await repo.putSubscription(device({ label: 'Renamed', keys: { p256dh: 'p2', auth: 'a2' }, createdAt: 'ignored', failures: 0 }))).toBe(false);
    expect(await repo.getSubscription('u1', device().id)).toEqual(device({ label: 'Renamed', keys: { p256dh: 'p2', auth: 'a2' }, failures: 1, lastFailureAt: '2026-10-02T00:00:00.000Z' }));
  });

  it('lists the devices of one user only, and deletes one', async () => {
    const repo = new ItemNotificationRepository(new MemoryItemStore());
    await repo.putSubscription(device());
    await repo.putSubscription(device({ id: 'b'.repeat(32) }));
    await repo.putSubscription(device({ userId: 'u2' }));
    expect((await repo.listSubscriptions('u1')).map((d) => d.id)).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
    expect(await repo.deleteSubscription('u1', 'a'.repeat(32))).toBe(true);
    expect(await repo.deleteSubscription('u1', 'a'.repeat(32))).toBe(false);
    expect(await repo.getSubscription('u1', 'a'.repeat(32))).toBeNull();
    expect(await repo.listSubscriptions('u2')).toHaveLength(1);
  });

  it('records deliveries: success resets the failures, failures count up, an unknown device is ignored', async () => {
    const repo = new ItemNotificationRepository(new MemoryItemStore());
    await repo.putSubscription(device());
    await repo.recordDelivery('u1', device().id, 'failure', 't1');
    await repo.recordDelivery('u1', device().id, 'failure', 't2');
    expect(await repo.getSubscription('u1', device().id)).toMatchObject({ failures: 2, lastFailureAt: 't2' });
    await repo.recordDelivery('u1', device().id, 'success', 't3');
    expect(await repo.getSubscription('u1', device().id)).toMatchObject({ failures: 0, lastSuccessAt: 't3', lastFailureAt: 't2' });
    await expect(repo.recordDelivery('u1', 'f'.repeat(32), 'success', 't4')).resolves.toBeUndefined();
    expect(await repo.getSubscription('u1', 'f'.repeat(32))).toBeNull();
  });

  it('keeps a ledger and prunes what is older than 400 days', async () => {
    const store = new MemoryItemStore();
    const repo = new ItemNotificationRepository(store);
    const now = new Date('2026-11-04T08:00:00.000Z');
    const day = 86_400_000;
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * day).toISOString();
    await repo.recordNotified('u1', [{ type: 'declared', symbol: 'KMB', eventKey: 'old' }], at(NOTIFIED_RETENTION_DAYS + 1), false);
    await repo.recordNotified('u1', [{ type: 'declared', symbol: 'KMB', eventKey: 'edge' }], at(NOTIFIED_RETENTION_DAYS - 1), true);
    await repo.recordNotified('u2', [{ type: 'received', symbol: 'KMB', eventKey: 'other-user' }], at(NOTIFIED_RETENTION_DAYS + 5), false);
    expect([...(await repo.listNotified('u1'))].sort((a, b) => a.localeCompare(b))).toEqual(['declared#KMB#edge', 'declared#KMB#old']);
    expect(await repo.pruneNotified('u1', now)).toBe(1);
    expect([...(await repo.listNotified('u1'))]).toEqual(['declared#KMB#edge']);
    expect((await repo.listNotified('u2')).size).toBe(1);
    expect(await repo.pruneNotified('u1', now)).toBe(0);
    expect(await store.get(notificationKeys.notified('u1', 'declared', 'KMB', 'edge'))).toMatchObject({ entityType: 'NOTIFIED', silent: true });
  });

  it('records nothing for an empty list and lists the registered users', async () => {
    const store = new MemoryItemStore();
    const repo = new ItemNotificationRepository(store);
    await expect(repo.recordNotified('u1', [], 't', false)).resolves.toBeUndefined();
    expect(await repo.listUserIds()).toEqual([]);
    await registerUser(store, 'github-1', 't');
    await registerUser(store, 'github-2', 't');
    expect((await repo.listUserIds()).sort((a, b) => a.localeCompare(b))).toEqual(['github-1', 'github-2']);
  });
});
