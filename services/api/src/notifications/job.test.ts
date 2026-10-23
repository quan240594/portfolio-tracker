import { MemoryItemStore, registerUser, silentLogger, setLogger, type PushResult } from '@portfolio/platform';
import { notificationKeys, sampleSummary, type DividendEvent, type InstrumentProfile, type PushSubscriptionItem, type Transaction } from '@portfolio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baselineUser } from './data.js';
import { MAX_PUSHES_PER_USER_STEP, backedOff, notifyDividendsJob, planNotifications, type NotifyJobDeps, type NotifyResult } from './job.js';
import { ItemNotificationRepository } from './repository.js';
import { InMemoryRepository } from '../testing/fakes.js';

// 09:00 Amsterdam (CET) on Wednesday 4 November 2026.
const MORNING = new Date('2026-11-04T08:00:00Z');
const NIGHT = new Date('2026-11-04T21:30:00Z');
const USER = 'github-1';

let counter = 0;
const tx = (overrides: Partial<Transaction>): Transaction => ({
  id: `t${++counter}`,
  userId: USER,
  portfolioId: 'p1',
  date: '2025-01-10',
  type: 'BUY',
  symbol: 'KMB',
  quantity: 6.4,
  price: 100,
  fee: 0,
  currency: 'USD',
  createdAt: '2025-01-10T00:00:00Z',
  ...overrides,
});

const event = (overrides: Partial<DividendEvent>): DividendEvent => ({ symbol: 'KMB', exDate: '2026-11-06', payDate: '2026-12-02', amount: 1.28, currency: 'USD', ...overrides });

const HISTORY: DividendEvent[] = [
  event({ exDate: '2025-11-06', payDate: '2025-12-02', amount: 1.21 }),
  event({ exDate: '2026-02-05', payDate: '2026-03-02', amount: 1.22 }),
  event({ exDate: '2026-05-07', payDate: '2026-06-02', amount: 1.25 }),
  event({ exDate: '2026-08-06', payDate: '2026-09-02', amount: 1.25 }),
];

interface Harness {
  repo: InMemoryRepository;
  store: MemoryItemStore;
  notifications: ItemNotificationRepository;
  sent: { endpoint: string; payload: Record<string, string> }[];
  results: Map<string, PushResult>;
  clock: { now: Date };
  deps: NotifyJobDeps;
  run(payload?: { trigger: 'scheduled' | 'sync'; userId?: string }): Promise<NotifyResult>;
  addDevice(name: string, overrides?: Partial<PushSubscriptionItem>): Promise<PushSubscriptionItem>;
  ledger(): Promise<string[]>;
}

function harness(): Harness {
  const repo = new InMemoryRepository();
  const store = new MemoryItemStore();
  const notifications = new ItemNotificationRepository(store);
  const sent: Harness['sent'] = [];
  const results = new Map<string, PushResult>();
  const clock = { now: MORNING };
  const deps: NotifyJobDeps = {
    repo,
    notifications,
    baseCurrency: 'EUR',
    now: () => clock.now,
    send: (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, payload: payload as Record<string, string> });
      return Promise.resolve(results.get(subscription.endpoint) ?? { kind: 'ok', status: 201 });
    },
  };
  const job = notifyDividendsJob(() => deps);
  const run: Harness['run'] = async (payload = { trigger: 'sync' as const }) => {
    let cursor: string | undefined;
    for (let step = 0; step < 50; step++) {
      const result = await job({ payload, cursor });
      if (result.done) return result.result;
      cursor = result.next;
    }
    throw new Error('did not finish');
  };
  const addDevice: Harness['addDevice'] = async (name, overrides = {}) => {
    const device: PushSubscriptionItem = { userId: USER, id: name.padEnd(32, '0').slice(0, 32), endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: 'p', auth: 'a' }, label: name, createdAt: '2026-10-01T00:00:00Z', failures: 0, ...overrides };
    await notifications.putSubscription(device);
    return device;
  };
  const ledger = async () => [...(await notifications.listNotified(USER))].sort((a, b) => a.localeCompare(b));
  return { repo, store, notifications, sent, results, clock, deps, run, addDevice, ledger };
}

async function enable(h: Harness, settings: Partial<{ received: boolean; declared: boolean; exDividend: boolean; earnings: boolean }> = {}): Promise<void> {
  await h.notifications.putSettings({ userId: USER, types: { exDividend: true, declared: true, received: true, earnings: true, ...settings }, exDividendDaysBefore: 2, createdAt: 'x', updatedAt: 'x' });
  await registerUser(h.store, USER, '2026-10-01T00:00:00Z');
}

function holdKmb(h: Harness, withNewEvent = true): void {
  h.repo.transactions = [tx({})];
  h.repo.dividendEvents = withNewEvent ? [...HISTORY, event({})] : HISTORY;
  h.repo.profiles = { KMB: { symbol: 'KMB', name: 'Kimberly-Clark Corporation' } as InstrumentProfile };
  h.repo.fx = { base: 'EUR', rates: { USD: 1.1 }, asOf: '2026-11-04' };
}

beforeEach(() => setLogger(silentLogger));
afterEach(() => vi.restoreAllMocks());

describe('notifyDividendsJob', () => {
  it('sends the ex-dividend reminder and the new-dividend announcement once, with the comparison in the text', async () => {
    const h = harness();
    await enable(h);
    await h.addDevice('phone');
    holdKmb(h);
    expect(await h.run()).toEqual({ users: 1, notifications: 2, pushes: 2 });
    const titles = h.sent.map((s) => s.payload.title);
    expect(titles).toEqual(['Kimberly-Clark declared $1.28 per share', 'Kimberly-Clark goes ex-dividend in 2 days (06-11-2026)']);
    expect(h.sent[0]!.payload).toMatchObject({ type: 'declared', url: '/assets/KMB', tag: 'declared:KMB:2026-11-06' });
    expect(h.sent[0]!.payload.body).toBe('Ex-date 06-11-2026, pay 02-12-2026 · +2.4 % vs last quarter · +5.8 % vs a year ago · about EUR 7.45 for your 6.4 shares');
    expect(await h.ledger()).toEqual(['declared#KMB#2026-11-06', 'exDividend#KMB#2026-11-06']);
  });

  it('sends nothing twice when the job runs again, or fires twice in a row', async () => {
    const h = harness();
    await enable(h);
    await h.addDevice('phone');
    holdKmb(h);
    await h.run();
    expect(await h.run()).toEqual({ users: 1, notifications: 0, pushes: 0 });
    expect(await h.run({ trigger: 'scheduled' })).toEqual({ users: 1, notifications: 0, pushes: 0 });
    expect(h.sent).toHaveLength(2);
  });

  it('delivers to every device and records the ledger once', async () => {
    const h = harness();
    await enable(h);
    await h.addDevice('phone');
    await h.addDevice('tablet');
    holdKmb(h);
    expect(await h.run()).toEqual({ users: 1, notifications: 2, pushes: 4 });
    expect(h.sent.map((s) => s.endpoint.split('/').at(-1))).toEqual(['phone', 'tablet', 'phone', 'tablet']);
    expect(await h.ledger()).toHaveLength(2);
    expect((await h.notifications.listSubscriptions(USER)).map((d) => [d.failures, d.lastSuccessAt])).toEqual([[0, MORNING.toISOString()], [0, MORNING.toISOString()]]);
  });

  describe('quiet hours', () => {
    it.each([[new Date('2026-11-04T21:00:00Z')], [new Date('2026-11-04T23:30:00Z')], [new Date('2026-11-05T05:59:00Z')]])('sends nothing and leaves the ledger alone at %s', async (now) => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      holdKmb(h);
      h.clock.now = now;
      expect(await h.run()).toMatchObject({ skipped: 'quiet-hours', pushes: 0 });
      expect(h.sent).toEqual([]);
      expect(await h.ledger()).toEqual([]);
    });

    it('catches up in the morning: what was held back is sent then', async () => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      holdKmb(h);
      h.clock.now = NIGHT;
      await h.run();
      h.clock.now = new Date('2026-11-05T07:00:00Z');
      expect(await h.run({ trigger: 'scheduled' })).toMatchObject({ notifications: 2 });
      expect(h.sent.map((s) => String(s.payload.type)).sort((a, b) => a.localeCompare(b))).toEqual(['declared', 'exDividend']);
    });

    it('sends from 08:00 up to 22:00 Amsterdam time, in summer time too', async () => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      holdKmb(h);
      h.clock.now = new Date('2026-11-04T20:59:00Z');
      expect(await h.run()).toMatchObject({ notifications: 2 });
    });
  });

  describe('received', () => {
    const received = (overrides: Partial<Transaction> = {}) => tx({ type: 'DIVIDEND', date: '2026-11-03', quantity: 6.4, price: 1.28, fee: 0.3, currency: 'USD', ...overrides });

    it('announces a dividend the sync recorded, with the net amount, once', async () => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      holdKmb(h, false);
      const t = received({ fxRate: 1.2 });
      h.repo.transactions = [tx({}), t];
      expect(await h.run({ trigger: 'sync', userId: USER })).toMatchObject({ notifications: 1 });
      expect(h.sent[0]!.payload).toMatchObject({ type: 'received', title: 'Kimberly-Clark dividend received: EUR 6.58', tag: `received:KMB:2026-11-03:${t.id}` });
      expect(await h.ledger()).toEqual([`received#KMB#${t.id}`]);
      await h.run({ trigger: 'sync', userId: USER });
      expect(h.sent).toHaveLength(1);
    });

    it('records a back-dated import silently', async () => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      holdKmb(h, false);
      const old = received({ date: '2025-06-01' });
      h.repo.transactions = [tx({}), old];
      expect(await h.run()).toMatchObject({ notifications: 0 });
      expect(h.sent).toEqual([]);
      expect(await h.ledger()).toEqual([`received#KMB#${old.id}`]);
    });
  });

  describe('earnings summaries', () => {
    const hold = (h: Harness, ...symbols: string[]): void => {
      h.repo.transactions = symbols.map((symbol) => tx({ symbol }));
    };

    it('announces a fresh live summary of a held symbol once, with the template key figure', async () => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      hold(h, 'NWND');
      h.repo.earningsSummaries = [sampleSummary({ symbol: 'NWND', name: 'Northwind Aerospace Corporation', reportDate: '2026-11-03', period: 'Q3 2026' })];
      expect(await h.run()).toEqual({ users: 1, notifications: 1, pushes: 1 });
      expect(h.sent[0]!.payload).toEqual({
        type: 'earnings',
        symbol: 'NWND',
        title: 'Northwind Aerospace reported Q3 2026: EPS beat by 7.3 %',
        body: 'Revenue $20.71B +11 % YoY · FCF/share $10.67 · guidance raised',
        url: '/earnings/NWND',
        tag: 'earnings:NWND:2026-11-03',
      });
      expect(await h.ledger()).toEqual(['earnings#NWND#2026-11-03']);
      expect(await h.run()).toMatchObject({ notifications: 0 });
      expect(h.sent).toHaveLength(1);
    });

    it('records a backfilled or older summary silently so the first run after deploy sends nothing', async () => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      hold(h, 'NWND', 'CLDV', 'GONE');
      h.repo.earningsSummaries = [
        sampleSummary({ symbol: 'NWND', reportDate: '2026-11-03', origin: 'backfill' }),
        sampleSummary({ symbol: 'CLDV', reportDate: '2026-10-20' }),
      ];
      expect(await h.run()).toMatchObject({ notifications: 0, pushes: 0 });
      expect(h.sent).toEqual([]);
      expect(await h.ledger()).toEqual(['earnings#CLDV#2026-10-20', 'earnings#NWND#2026-11-03']);
    });

    it('waits for the morning when the release arrives in quiet hours, and only if the type is on', async () => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      hold(h, 'NWND');
      h.repo.earningsSummaries = [sampleSummary({ symbol: 'NWND', reportDate: '2026-11-03' })];
      h.clock.now = NIGHT;
      expect(await h.run()).toMatchObject({ skipped: 'quiet-hours' });
      h.clock.now = MORNING;
      expect(await h.run()).toMatchObject({ notifications: 1 });
      const off = harness();
      await enable(off, { earnings: false });
      await off.addDevice('phone');
      hold(off, 'NWND');
      off.repo.earningsSummaries = [sampleSummary({ symbol: 'NWND', reportDate: '2026-11-03' })];
      expect(await off.run()).toMatchObject({ notifications: 0 });
      expect(off.sent).toEqual([]);
    });

    it('names a summary of several earnings "earnings updates" and a mixed one "portfolio updates"', async () => {
      const h = harness();
      await enable(h, { exDividend: false });
      await h.addDevice('phone');
      const symbols = ['AAA', 'BBB', 'CCC', 'DDD'];
      hold(h, ...symbols);
      h.repo.earningsSummaries = symbols.map((symbol) => sampleSummary({ symbol, name: symbol, reportDate: '2026-11-03' }));
      expect(await h.run()).toMatchObject({ notifications: 1 });
      expect(h.sent[0]!.payload).toMatchObject({ type: 'summary', title: '4 earnings updates' });
      const mixed = harness();
      await enable(mixed, { exDividend: false });
      await mixed.addDevice('phone');
      hold(mixed, ...symbols);
      mixed.repo.earningsSummaries = [sampleSummary({ symbol: 'AAA', name: 'AAA', reportDate: '2026-11-03' }), sampleSummary({ symbol: 'BBB', name: 'BBB', reportDate: '2026-11-03' })];
      mixed.repo.dividendEvents = [event({ symbol: 'CCC' }), event({ symbol: 'DDD' })];
      expect(await mixed.run()).toMatchObject({ notifications: 1 });
      expect(mixed.sent[0]!.payload.title).toBe('4 portfolio updates');
    });

    it('works for settings saved before the type existed (it is on by default) and baselines the stored summaries when it is switched on', async () => {
      const h = harness();
      await h.notifications.putSettings({ userId: USER, types: { exDividend: false, declared: false, received: false } as never, exDividendDaysBefore: 2, createdAt: 'x', updatedAt: 'x' });
      await registerUser(h.store, USER, 'x');
      await h.addDevice('phone');
      hold(h, 'NWND');
      h.repo.earningsSummaries = [sampleSummary({ symbol: 'NWND', reportDate: '2026-11-03' })];
      expect(await h.run()).toMatchObject({ notifications: 1 });
      const fresh = harness();
      hold(fresh, 'NWND');
      fresh.repo.earningsSummaries = [sampleSummary({ symbol: 'NWND', reportDate: '2026-11-03' })];
      await baselineUser(fresh.repo, fresh.notifications, USER, MORNING, ['earnings']);
      expect(await fresh.ledger()).toEqual(['earnings#NWND#2026-11-03']);
      expect([...(await fresh.store.query({ pk: `USER#${USER}`, sk: { beginsWith: 'NOTIFIED#' } })).items][0]).toMatchObject({ silent: true });
    });
  });

  describe('baseline', () => {
    it('a first subscription marks history and declared dividends as notified: the first run announces only the reminder', async () => {
      const h = harness();
      holdKmb(h);
      h.repo.transactions = [tx({}), tx({ type: 'DIVIDEND', date: '2026-11-02', price: 1.25, symbol: 'KMB' })];
      await enable(h);
      await h.addDevice('phone');
      await baselineUser(h.repo, h.notifications, USER, MORNING, ['declared', 'received']);
      expect(await h.run()).toMatchObject({ notifications: 1 });
      expect(h.sent.map((s) => s.payload.type)).toEqual(['exDividend']);
    });

    it('a failing baseline is swallowed', async () => {
      const h = harness();
      h.repo.transactions = [tx({ type: 'SELL', quantity: 9 })];
      await expect(baselineUser(h.repo, h.notifications, USER, MORNING, ['declared'])).resolves.toBeUndefined();
      expect(await h.ledger()).toEqual([]);
    });
  });

  describe('grouping', () => {
    function holdMany(h: Harness, count: number): void {
      const symbols = Array.from({ length: count }, (_unused, index) => `S${index}`);
      h.repo.transactions = symbols.map((symbol) => tx({ symbol }));
      h.repo.dividendEvents = symbols.map((symbol, index) => event({ symbol, exDate: `2026-11-${String(20 + index).padStart(2, '0')}`, payDate: undefined, amount: 1 + index }));
    }

    it('sends up to three items one by one', async () => {
      const h = harness();
      await enable(h, { exDividend: false });
      await h.addDevice('phone');
      holdMany(h, 3);
      expect(await h.run()).toMatchObject({ notifications: 3, pushes: 3 });
      expect(h.sent.map((s) => s.payload.type)).toEqual(['declared', 'declared', 'declared']);
    });

    it('sends one summary for more than three, lists three, opens the calendar and ledgers every item', async () => {
      const h = harness();
      await enable(h, { exDividend: false });
      await h.addDevice('phone');
      holdMany(h, 5);
      expect(await h.run()).toMatchObject({ notifications: 1, pushes: 1 });
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]!.payload).toMatchObject({ type: 'summary', title: '5 dividend updates', url: '/calendar' });
      expect(h.sent[0]!.payload.body).toBe('S0 declared $1.00 · S1 declared $2.00 · S2 declared $3.00 · and 2 more');
      expect(await h.ledger()).toHaveLength(5);
      expect(await h.run()).toMatchObject({ notifications: 0 });
    });

    it('plans at most three notifications per device, so a step stays within its push budget', () => {
      expect(MAX_PUSHES_PER_USER_STEP).toBe(30);
      expect(planNotifications([], '2026-11-04')).toEqual([]);
    });
  });

  describe('devices', () => {
    it('deletes a device the push service reports gone and still delivers to the others', async () => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      await h.addDevice('old');
      h.results.set('https://fcm.googleapis.com/fcm/send/old', { kind: 'gone', status: 410 });
      holdKmb(h);
      expect(await h.run()).toMatchObject({ notifications: 2, pushes: 2 });
      expect((await h.notifications.listSubscriptions(USER)).map((d) => d.label)).toEqual(['phone']);
      // the gone device is asked once, not for the second notification
      expect(h.sent.filter((s) => s.endpoint.endsWith('/old'))).toHaveLength(1);
    });

    it('deletes a device whose stored endpoint no longer passes the SSRF check', async () => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      await h.addDevice('bad');
      h.results.set('https://fcm.googleapis.com/fcm/send/bad', { kind: 'rejected', reason: 'invalid-endpoint' });
      holdKmb(h);
      await h.run();
      expect((await h.notifications.listSubscriptions(USER)).map((d) => d.label)).toEqual(['phone']);
    });

    it('records no ledger entry when no device accepted, backs the device off, and retries once the backoff has passed', async () => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      holdKmb(h);
      h.results.set('https://fcm.googleapis.com/fcm/send/phone', { kind: 'retryable', reason: 'network' });
      expect(await h.run()).toEqual({ users: 1, notifications: 0, pushes: 0 });
      expect(await h.ledger()).toEqual([]);
      // one attempt for the first notification only: the failing device is not asked again in the same run
      expect(h.sent).toHaveLength(1);
      expect((await h.notifications.listSubscriptions(USER))[0]).toMatchObject({ failures: 1, lastFailureAt: MORNING.toISOString() });

      // within the backoff nothing is attempted
      h.clock.now = new Date(MORNING.getTime() + 10 * 60_000);
      expect(await h.run()).toEqual({ users: 1, notifications: 0, pushes: 0 });
      expect(h.sent).toHaveLength(1);

      // after it, and with the service back, everything due goes out
      h.clock.now = new Date(MORNING.getTime() + 20 * 60_000);
      h.results.clear();
      expect(await h.run()).toMatchObject({ notifications: 2 });
      expect(await h.ledger()).toHaveLength(2);
      expect((await h.notifications.listSubscriptions(USER))[0]).toMatchObject({ failures: 0 });
    });

    it('treats a rate limit and a rejection like a failure and never loops', async () => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      holdKmb(h);
      h.results.set('https://fcm.googleapis.com/fcm/send/phone', { kind: 'rate-limited', status: 429, retryAfterSeconds: 60 });
      await h.run();
      expect(h.sent).toHaveLength(1);
      h.results.set('https://fcm.googleapis.com/fcm/send/phone', { kind: 'rejected', reason: 'refused', status: 403 });
      h.clock.now = new Date(MORNING.getTime() + 60 * 60_000);
      await h.run();
      expect(h.sent).toHaveLength(2);
      expect((await h.notifications.listSubscriptions(USER))[0]!.failures).toBe(2);
    });

    it('computes the backoff: 15 minutes, doubling, at most a day', () => {
      const failedAt = MORNING.toISOString();
      const after = (minutes: number) => new Date(MORNING.getTime() + minutes * 60_000);
      expect(backedOff({ failures: 0, lastFailureAt: failedAt }, MORNING)).toBe(false);
      expect(backedOff({ failures: 3 }, MORNING)).toBe(false);
      expect(backedOff({ failures: 1, lastFailureAt: failedAt }, after(14))).toBe(true);
      expect(backedOff({ failures: 1, lastFailureAt: failedAt }, after(15))).toBe(false);
      expect(backedOff({ failures: 3, lastFailureAt: failedAt }, after(59))).toBe(true);
      expect(backedOff({ failures: 3, lastFailureAt: failedAt }, after(60))).toBe(false);
      expect(backedOff({ failures: 30, lastFailureAt: failedAt }, after(24 * 60 - 1))).toBe(true);
      expect(backedOff({ failures: 30, lastFailureAt: failedAt }, after(24 * 60))).toBe(false);
    });
  });

  describe('who is notified', () => {
    it('skips users without settings, without devices or with every type off', async () => {
      const h = harness();
      holdKmb(h);
      await registerUser(h.store, USER, 'x');
      expect(await h.run()).toEqual({ users: 0, notifications: 0, pushes: 0 });
      await enable(h);
      expect(await h.run()).toEqual({ users: 0, notifications: 0, pushes: 0 });
      await h.addDevice('phone');
      await enable(h, { exDividend: false, declared: false, received: false, earnings: false });
      expect(await h.run()).toEqual({ users: 0, notifications: 0, pushes: 0 });
      expect(h.sent).toEqual([]);
    });

    it('walks every registered user, one step each, and one failing user does not stop the others', async () => {
      const h = harness();
      holdKmb(h);
      await enable(h);
      await h.addDevice('phone');
      const other = 'github-2';
      await registerUser(h.store, other, 'x');
      await h.notifications.putSettings({ userId: other, types: { exDividend: true, declared: true, received: true, earnings: true }, exDividendDaysBefore: 2, createdAt: 'x', updatedAt: 'x' });
      await h.notifications.putSubscription({ userId: other, id: 'b'.repeat(32), endpoint: 'https://fcm.googleapis.com/fcm/send/other', keys: { p256dh: 'p', auth: 'a' }, label: 'other', createdAt: 'x', failures: 0 });
      h.repo.transactions = [tx({}), tx({ userId: other, type: 'SELL', quantity: 99 })];
      const job = notifyDividendsJob(() => h.deps);
      const first = await job({ payload: { trigger: 'scheduled' } });
      expect(first.done).toBe(false);
      const second = await job({ payload: { trigger: 'scheduled' }, cursor: first.done ? undefined : first.next });
      expect(second).toEqual({ done: true, result: { users: 1, notifications: 2, pushes: 2 } });
    });

    it('is skipped when the push sender is not configured', async () => {
      const job = notifyDividendsJob(() => undefined);
      expect(await job({ payload: { trigger: 'scheduled' } })).toEqual({ done: true, result: { users: 0, notifications: 0, pushes: 0, skipped: 'not-configured' } });
    });

    it('finishes at once for an empty cursor position', async () => {
      const h = harness();
      const job = notifyDividendsJob(() => h.deps);
      expect(await job({ payload: { trigger: 'sync' }, cursor: JSON.stringify({ users: [], index: 0, totals: { users: 3, notifications: 2, pushes: 1 } }) })).toEqual({ done: true, result: { users: 3, notifications: 2, pushes: 1 } });
    });
  });

  describe('the ledger', () => {
    it('prunes entries older than 400 days on the scheduled run and keeps the rest', async () => {
      const h = harness();
      await enable(h);
      await h.addDevice('phone');
      holdKmb(h, false);
      await h.notifications.recordNotified(USER, [{ type: 'declared', symbol: 'OLD', eventKey: '2024-01-01' }], '2025-01-01T00:00:00Z', false);
      await h.notifications.recordNotified(USER, [{ type: 'declared', symbol: 'NEW', eventKey: '2026-10-01' }], '2026-10-01T00:00:00Z', false);
      await h.run({ trigger: 'sync' });
      expect(await h.ledger()).toEqual(['declared#NEW#2026-10-01', 'declared#OLD#2024-01-01']);
      await h.run({ trigger: 'scheduled' });
      expect(await h.ledger()).toEqual(['declared#NEW#2026-10-01']);
    });

    it('stores entries under the user partition with the documented shape', async () => {
      const h = harness();
      await h.notifications.recordNotified(USER, [{ type: 'received', symbol: 'KMB', eventKey: 'tx-1' }], '2026-11-04T08:00:00.000Z', true);
      const item = await h.store.get(notificationKeys.notified(USER, 'received', 'KMB', 'tx-1'));
      expect(item).toMatchObject({ entityType: 'NOTIFIED', userId: USER, type: 'received', symbol: 'KMB', eventKey: 'tx-1', notifiedAt: '2026-11-04T08:00:00.000Z', silent: true });
    });
  });

  it('does not log the payload, the endpoint or the keys', async () => {
    const lines: string[] = [];
    const record = (message: string, fields?: object) => {
      lines.push(JSON.stringify({ message, ...fields }));
    };
    const logger = { debug: record, info: record, warn: record, error: record, appendKeys: () => undefined, removeKeys: () => undefined, createChild: () => logger };
    setLogger(logger);
    const h = harness();
    await enable(h);
    await h.addDevice('phone');
    holdKmb(h);
    h.repo.transactions = [tx({ type: 'SELL', quantity: 99 })];
    await h.run();
    expect(lines.join('\n')).not.toMatch(/fcm|Kimberly|KMB/);
  });
});
