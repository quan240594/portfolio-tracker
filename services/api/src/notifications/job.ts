import { logger, type JobHandler, type JobPayloads, type PushSender } from '@portfolio/platform';
import {
  MAX_SEPARATE_NOTIFICATIONS,
  NOTIFICATION_TYPES,
  buildSummaryNotification,
  effectiveNotificationSettings,
  detectDueNotifications,
  isQuietHour,
  localDayAndHour,
  sequentially,
  type DueNotification,
  type LedgerRef,
  type PushNotificationPayload,
  type PushSubscriptionItem,
} from '@portfolio/shared';
import type { Repository } from '../repository.js';
import { loadDividendData } from './data.js';
import type { NotificationRepository } from './repository.js';

export type NotifyPayload = JobPayloads['notifyDividends'];

export interface NotifyJobDeps {
  repo: Repository;
  notifications: NotificationRepository;
  send: PushSender;
  baseCurrency: string;
  now: () => Date;
}

export interface NotifyTotals {
  /** Users that had something to do (settings and at least one device). */
  users: number;
  /** Notifications at least one device accepted. */
  notifications: number;
  /** Pushes the push services accepted (one per device and notification). */
  pushes: number;
}

export type NotifyResult = NotifyTotals & { skipped?: 'not-configured' | 'quiet-hours' };

const NO_TOTALS: NotifyTotals = { users: 0, notifications: 0, pushes: 0 };
const PUSH_TTL_SECONDS = 24 * 3600;
const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 24 * 3_600_000;

/**
 * Pushes one user's step makes at most: every device gets at most three notifications (more are one summary). One push is one
 * subrequest, and the alarm plans 45 of them, so a step reserves this many.
 */
export const MAX_PUSHES_PER_USER_STEP = 10 * MAX_SEPARATE_NOTIFICATIONS;

/** A device that failed recently is left alone for 15 minutes, doubling with every consecutive failure up to a day. */
export function backedOff(device: Pick<PushSubscriptionItem, 'failures' | 'lastFailureAt'>, now: Date): boolean {
  if (device.failures <= 0 || device.lastFailureAt === undefined) return false;
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** (device.failures - 1), BACKOFF_MAX_MS);
  return now.getTime() < Date.parse(device.lastFailureAt) + wait;
}

export interface PlannedNotification {
  payload: PushNotificationPayload;
  /** The ledger entries that are written once a device accepted the push. */
  refs: LedgerRef[];
}

/** Up to three due items are sent one by one; more are folded into a single summary that opens the calendar. */
export function planNotifications(due: readonly DueNotification[], today: string): PlannedNotification[] {
  const toRef = ({ type, symbol, eventKey }: DueNotification): LedgerRef => ({ type, symbol, eventKey });
  if (due.length <= MAX_SEPARATE_NOTIFICATIONS) return due.map((item) => ({ payload: item.message.payload, refs: [toRef(item)] }));
  const kinds = new Set(due.map((item) => (item.type === 'earnings' ? 'earnings' : 'dividend')));
  const noun = kinds.size === 1 ? [...kinds][0]! : 'portfolio';
  return [{ payload: buildSummaryNotification(due.map((item) => item.message.line), today, noun), refs: due.map(toRef) }];
}

/** Sends `payload` to every device and keeps their records straight: gone devices are deleted, failing ones back off. Resolves the devices that accepted it. */
async function deliver(deps: NotifyJobDeps, userId: string, devices: PushSubscriptionItem[], payload: PushNotificationPayload): Promise<PushSubscriptionItem[]> {
  const at = deps.now().toISOString();
  const results = await Promise.all(devices.map((device) => deps.send({ endpoint: device.endpoint, keys: device.keys }, payload, { ttl: PUSH_TTL_SECONDS })));
  const bookkeeping = devices.map((device, index) => {
    const result = results[index]!;
    if (result.kind === 'ok') return deps.notifications.recordDelivery(userId, device.id, 'success', at);
    if (result.kind === 'gone' || (result.kind === 'rejected' && result.reason === 'invalid-endpoint')) return deps.notifications.deleteSubscription(userId, device.id);
    return deps.notifications.recordDelivery(userId, device.id, 'failure', at);
  });
  await Promise.all(bookkeeping);
  // A device that did not accept the push is not asked again in this run.
  return devices.filter((_device, index) => results[index]!.kind === 'ok');
}

async function processUser(deps: NotifyJobDeps, userId: string, trigger: NotifyPayload['trigger']): Promise<NotifyTotals> {
  const { notifications } = deps;
  const stored = await notifications.getSettings(userId);
  if (stored === null) return NO_TOTALS;
  const settings = effectiveNotificationSettings(stored);
  if (!NOTIFICATION_TYPES.some((type) => settings.types[type])) return NO_TOTALS;
  const devices = await notifications.listSubscriptions(userId);
  if (devices.length === 0) return NO_TOTALS;
  const now = deps.now();
  const { day } = localDayAndHour(now);
  // The daily run also forgets what is older than the ledger's retention.
  if (trigger === 'scheduled') await notifications.pruneNotified(userId, now);
  const [ledger, data] = await Promise.all([notifications.listNotified(userId), loadDividendData(deps.repo, userId, day, deps.baseCurrency)]);
  const { due, silent } = detectDueNotifications({ today: day, settings, baseCurrency: deps.baseCurrency, ...data, notified: ledger });
  if (silent.length > 0) await notifications.recordNotified(userId, silent, now.toISOString(), true);
  const active = devices.filter((device) => !backedOff(device, now));
  if (due.length === 0 || active.length === 0) return { users: 1, notifications: 0, pushes: 0 };

  let remaining = active;
  let sent = 0;
  let pushes = 0;
  const deliverPlanned = async (planned: PlannedNotification): Promise<number> => {
    if (remaining.length === 0) return 0;
    remaining = await deliver(deps, userId, remaining, planned.payload);
    // The ledger is written only once a device accepted the push; otherwise the next run tries again.
    if (remaining.length > 0) await notifications.recordNotified(userId, planned.refs, deps.now().toISOString(), false);
    return remaining.length;
  };
  for await (const accepted of sequentially(planNotifications(due, day), deliverPlanned)) {
    if (accepted > 0) sent += 1;
    pushes += accepted;
  }
  return { users: 1, notifications: sent, pushes };
}

interface NotifyCursor {
  users: string[];
  index: number;
  totals: NotifyTotals;
}

const addTotals = (a: NotifyTotals, b: NotifyTotals): NotifyTotals => ({ users: a.users + b.users, notifications: a.notifications + b.notifications, pushes: a.pushes + b.pushes });

async function startCursor(deps: NotifyJobDeps, payload: NotifyPayload): Promise<NotifyCursor> {
  return { users: payload.userId === undefined ? await deps.notifications.listUserIds() : [payload.userId], index: 0, totals: NO_TOTALS };
}

/**
 * The `notifyDividends` job: for every user (or the one in the payload) with settings and devices, send the ex-dividend reminders,
 * new-dividend announcements and received-dividend notices that are due and not in the ledger yet. Resumable (one user per step) and
 * idempotent: the ledger entry is written after a device accepted the push, so a second run, or a redelivered step, sends nothing twice.
 * Outside 08:00-22:00 Amsterdam time it sends nothing and leaves everything un-ledgered for the next run.
 */
export function notifyDividendsJob(getDeps: () => NotifyJobDeps | undefined): JobHandler<NotifyPayload, NotifyResult> {
  return async ({ payload, cursor }) => {
    const deps = getDeps();
    if (deps === undefined) return { done: true, result: { ...NO_TOTALS, skipped: 'not-configured' } };
    if (isQuietHour(localDayAndHour(deps.now()).hour)) return { done: true, result: { ...NO_TOTALS, skipped: 'quiet-hours' } };
    const state: NotifyCursor = cursor ? (JSON.parse(cursor) as NotifyCursor) : await startCursor(deps, payload);
    const userId = state.users[state.index];
    if (userId === undefined) return { done: true, result: state.totals };
    const outcome = await processUser(deps, userId, payload.trigger).catch((error: unknown) => {
      // One user's failure (an oversold position, a store error) must not stop the others or loop: the next run tries again.
      logger.error('Dividend notifications failed for a user', { error: error instanceof Error ? error.name : 'unknown' });
      return NO_TOTALS;
    });
    const next: NotifyCursor = { ...state, index: state.index + 1, totals: addTotals(state.totals, outcome) };
    if (next.index >= next.users.length) {
      logger.info('Dividend notifications sent', { ...next.totals });
      return { done: true, result: next.totals };
    }
    return { done: false, next: JSON.stringify(next) };
  };
}
