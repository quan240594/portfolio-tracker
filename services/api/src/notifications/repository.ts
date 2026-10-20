import { cond, listByPrefix, type Item, type ItemStore } from '@portfolio/platform';
import {
  NOTIFICATION_ENTITY,
  NOTIFIED_RETENTION_DAYS,
  fromItem,
  keys,
  ledgerId,
  notificationKeys,
  type LedgerRef,
  type NotificationSettingsItem,
  type NotifiedItem,
  type PushSubscriptionItem,
} from '@portfolio/shared';

const DAY_MS = 86_400_000;

/** Persistence of the push notification state: the user's settings, their devices and the ledger of what was already notified. */
export interface NotificationRepository {
  getSettings(userId: string): Promise<NotificationSettingsItem | null>;
  putSettings(settings: NotificationSettingsItem): Promise<void>;
  listSubscriptions(userId: string): Promise<PushSubscriptionItem[]>;
  getSubscription(userId: string, id: string): Promise<PushSubscriptionItem | null>;
  /** Creates the device, or replaces the keys and label of an existing one (keeping `createdAt` and the delivery record). Resolves true when it was created. */
  putSubscription(subscription: PushSubscriptionItem): Promise<boolean>;
  /** Resolves false when there was no such device. */
  deleteSubscription(userId: string, id: string): Promise<boolean>;
  /** Records the outcome of a delivery to a device: success resets `failures`, a failure counts up. */
  recordDelivery(userId: string, id: string, outcome: 'success' | 'failure', at: string): Promise<void>;
  /** The `ledgerId`s of everything notified so far. */
  listNotified(userId: string): Promise<Set<string>>;
  recordNotified(userId: string, refs: readonly LedgerRef[], at: string, silent: boolean): Promise<void>;
  /** Deletes ledger entries older than the retention (400 days); resolves how many. */
  pruneNotified(userId: string, now: Date): Promise<number>;
  /** Every registered user id (the user registry). */
  listUserIds(): Promise<string[]>;
}

/** NotificationRepository on an ItemStore (`USER#{userId}` partition, see `notificationKeys`). */
export class ItemNotificationRepository implements NotificationRepository {
  constructor(private readonly store: ItemStore) {}

  private listUser<T>(userId: string, prefix: string): Promise<T[]> {
    return listByPrefix<T>(this.store, keys.user(userId).PK, prefix, { consistent: true });
  }

  async getSettings(userId: string): Promise<NotificationSettingsItem | null> {
    const item = await this.store.get(notificationKeys.settings(userId), { consistent: true });
    return item ? fromItem<NotificationSettingsItem>(item) : null;
  }

  async putSettings(settings: NotificationSettingsItem): Promise<void> {
    await this.store.put({ ...notificationKeys.settings(settings.userId), entityType: NOTIFICATION_ENTITY.settings, ...settings });
  }

  listSubscriptions(userId: string): Promise<PushSubscriptionItem[]> {
    return this.listUser(userId, notificationKeys.subscriptionPrefix);
  }

  async getSubscription(userId: string, id: string): Promise<PushSubscriptionItem | null> {
    const item = await this.store.get(notificationKeys.subscription(userId, id), { consistent: true });
    return item ? fromItem<PushSubscriptionItem>(item) : null;
  }

  async putSubscription(subscription: PushSubscriptionItem): Promise<boolean> {
    const key = notificationKeys.subscription(subscription.userId, subscription.id);
    const item: Item = { ...key, entityType: NOTIFICATION_ENTITY.subscription, ...subscription };
    if (await this.store.put(item, { condition: cond.notExists })) return true;
    const { keys: deviceKeys, label, endpoint } = subscription;
    await this.store.update(key, { set: { keys: deviceKeys, label, endpoint } });
    return false;
  }

  deleteSubscription(userId: string, id: string): Promise<boolean> {
    return this.store.delete(notificationKeys.subscription(userId, id), { condition: cond.exists });
  }

  async recordDelivery(userId: string, id: string, outcome: 'success' | 'failure', at: string): Promise<void> {
    const key = notificationKeys.subscription(userId, id);
    const existing = await this.store.get(key, { consistent: true });
    if (!existing) return;
    const failures = typeof existing.failures === 'number' ? existing.failures : 0;
    const patch = outcome === 'success' ? { lastSuccessAt: at, failures: 0 } : { lastFailureAt: at, failures: failures + 1 };
    await this.store.update(key, { set: patch }, { condition: cond.exists });
  }

  async listNotified(userId: string): Promise<Set<string>> {
    const entries = await this.listUser<NotifiedItem>(userId, notificationKeys.notifiedPrefix);
    return new Set(entries.map((entry) => ledgerId(entry.type, entry.symbol, entry.eventKey)));
  }

  async recordNotified(userId: string, refs: readonly LedgerRef[], at: string, silent: boolean): Promise<void> {
    await this.store.batchWrite(
      refs.map(({ type, symbol, eventKey }) => {
        const entry: NotifiedItem = { userId, type, symbol, eventKey, notifiedAt: at, ...(silent ? { silent: true as const } : {}) };
        return { type: 'put', item: { ...notificationKeys.notified(userId, type, symbol, eventKey), entityType: NOTIFICATION_ENTITY.notified, ...entry } };
      }),
    );
  }

  async pruneNotified(userId: string, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - NOTIFIED_RETENTION_DAYS * DAY_MS).toISOString();
    const entries = await this.listUser<NotifiedItem>(userId, notificationKeys.notifiedPrefix);
    const expired = entries.filter((entry) => entry.notifiedAt < cutoff);
    await this.store.batchWrite(expired.map((entry) => ({ type: 'delete', key: notificationKeys.notified(userId, entry.type, entry.symbol, entry.eventKey) })));
    return expired.length;
  }

  async listUserIds(): Promise<string[]> {
    const users = await listByPrefix<{ userId: string }>(this.store, keys.userRegistry('').PK, 'USER#');
    return users.map((user) => user.userId);
  }
}
