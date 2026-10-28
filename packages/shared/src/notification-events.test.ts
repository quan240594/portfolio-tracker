import { describe, expect, it } from 'vitest';
import { baselineEntries, currentHoldings, detectDueNotifications, heldQuantities, ledgerId, type DetectInput } from './notification-events.js';
import { customSymbol } from './management-api.js';
import { defaultNotificationSettings } from './notifications.js';
import type { DividendEvent, FxRates, Transaction } from './types.js';

const TODAY = '2026-11-04';
const FX: FxRates = { base: 'EUR', rates: { USD: 1.1 }, asOf: TODAY };

let counter = 0;
const tx = (overrides: Partial<Transaction>): Transaction => ({
  id: `t${++counter}`,
  userId: 'u1',
  portfolioId: 'p1',
  date: '2025-01-10',
  type: 'BUY',
  symbol: 'KMB',
  quantity: 10,
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

const base = (overrides: Partial<DetectInput> = {}): DetectInput => ({
  today: TODAY,
  settings: defaultNotificationSettings(),
  baseCurrency: 'EUR',
  transactions: [tx({ quantity: 6.4 })],
  dividendEvents: [...HISTORY, event({})],
  names: { KMB: 'Kimberly-Clark Corporation' },
  fx: FX,
  notified: new Set(),
  ...overrides,
});

describe('declared and ex-dividend', () => {
  it('announces a new dividend and the ex-dividend date that is within the lead time', () => {
    const { due, silent } = detectDueNotifications(base());
    expect(silent).toEqual([]);
    expect(due.map((d) => d.id)).toEqual(['declared#KMB#2026-11-06', 'exDividend#KMB#2026-11-06']);
    const declared = due.find((d) => d.type === 'declared')!.message.payload;
    expect(declared.title).toBe('Kimberly-Clark declared $1.28 per share');
    expect(declared.body).toBe('Ex-date 06-11-2026, pay 02-12-2026 · +2.4 % vs last quarter · +5.8 % vs a year ago · about EUR 7.45 for your 6.4 shares');
    const ex = due.find((d) => d.type === 'exDividend')!.message.payload;
    expect(ex.title).toBe('Kimberly-Clark goes ex-dividend in 2 days (06-11-2026)');
    expect(ex.body).toBe('$1.28 per share, +2.4 % vs last quarter, +5.8 % vs a year ago');
  });

  it('only reminds within the configured number of days before the ex-date', () => {
    const settings = { ...defaultNotificationSettings(), exDividendDaysBefore: 1 };
    expect(detectDueNotifications(base({ settings })).due.map((d) => d.type)).toEqual(['declared']);
    expect(detectDueNotifications(base({ settings: { ...settings, exDividendDaysBefore: 5 }, today: '2026-11-01' })).due.map((d) => d.type)).toEqual(['declared', 'exDividend']);
    expect(detectDueNotifications(base({ settings: { ...settings, exDividendDaysBefore: 5 }, today: '2026-10-31' })).due.map((d) => d.type)).toEqual(['declared']);
  });

  it('does not remind on the ex-date itself or after it', () => {
    expect(detectDueNotifications(base({ today: '2026-11-06' })).due.map((d) => d.type)).toEqual(['declared']);
    expect(detectDueNotifications(base({ today: '2026-11-07' })).due.map((d) => d.type)).toEqual(['declared']);
  });

  it('skips what the ledger already holds', () => {
    const notified = new Set([ledgerId('exDividend', 'KMB', '2026-11-06'), ledgerId('declared', 'KMB', '2026-11-06')]);
    expect(detectDueNotifications(base({ notified })).due).toEqual([]);
  });

  it('a stored event with a new ex-date is a new declaration even when an older one is in the ledger', () => {
    const notified = new Set([ledgerId('declared', 'KMB', '2026-11-06'), ledgerId('exDividend', 'KMB', '2026-11-06')]);
    const next = event({ exDate: '2027-02-05', payDate: '2027-03-02', amount: 1.3 });
    const { due } = detectDueNotifications(base({ notified, dividendEvents: [...HISTORY, event({}), next] }));
    expect(due.map((d) => d.id)).toEqual(['declared#KMB#2027-02-05']);
  });

  it('still announces a dividend whose ex-date has passed when it is not paid yet', () => {
    const { due } = detectDueNotifications(base({ today: '2026-11-10' }));
    expect(due.map((d) => d.id)).toEqual(['declared#KMB#2026-11-06']);
  });

  it('ignores dividends that are completely in the past', () => {
    expect(detectDueNotifications(base({ today: '2026-12-03' })).due).toEqual([]);
  });

  it('ignores symbols that are not held, including a position that was sold', () => {
    const sold = [tx({ quantity: 6.4 }), tx({ type: 'SELL', quantity: 6.4, date: '2026-09-01' })];
    expect(detectDueNotifications(base({ transactions: sold })).due).toEqual([]);
    expect(detectDueNotifications(base({ transactions: [tx({ symbol: 'MSFT' })] })).due).toEqual([]);
  });

  it('ignores zero-amount events', () => {
    expect(detectDueNotifications(base({ dividendEvents: [event({ amount: 0 })] })).due).toEqual([]);
  });

  it('keeps the last stored event per ex-date', () => {
    const { due } = detectDueNotifications(base({ dividendEvents: [...HISTORY, event({ amount: 1 }), event({ amount: 1.28 })] }));
    expect(due.filter((d) => d.type === 'declared')).toHaveLength(1);
    expect(due.find((d) => d.type === 'declared')!.message.payload.title).toContain('$1.28');
  });

  it('respects the type switches', () => {
    const off = (type: 'exDividend' | 'declared' | 'received' | 'earnings') => ({ ...defaultNotificationSettings(), types: { ...defaultNotificationSettings().types, [type]: false } });
    expect(detectDueNotifications(base({ settings: off('exDividend') })).due.map((d) => d.type)).toEqual(['declared']);
    expect(detectDueNotifications(base({ settings: off('declared') })).due.map((d) => d.type)).toEqual(['exDividend']);
    const none = { ...defaultNotificationSettings(), types: { exDividend: false, declared: false, received: false, earnings: false } };
    expect(detectDueNotifications(base({ settings: none })).due).toEqual([]);
  });

  it('leaves out the amount for your shares when the currency cannot be converted', () => {
    const body = detectDueNotifications(base({ fx: null })).due.find((d) => d.type === 'declared')!.message.payload.body;
    expect(body).not.toContain('about');
    const noRate = detectDueNotifications(base({ fx: { base: 'EUR', rates: {}, asOf: TODAY } })).due.find((d) => d.type === 'declared')!.message.payload.body;
    expect(noRate).not.toContain('about');
    const otherBase = detectDueNotifications(base({ fx: { base: 'USD', rates: { EUR: 0.9 }, asOf: TODAY } })).due.find((d) => d.type === 'declared')!.message.payload.body;
    expect(otherBase).not.toContain('about');
  });

  it('values the shares directly when the dividend is in the base currency', () => {
    const body = detectDueNotifications(base({ fx: null, dividendEvents: [event({ currency: 'EUR' })], settings: { ...defaultNotificationSettings(), types: { exDividend: false, declared: true, received: false, earnings: false } } })).due[0]!.message.payload.body;
    expect(body).toContain('about EUR 8.19 for your 6.4 shares');
  });

  it('nets the amount for your shares by the withholding observed in the last 12 months', () => {
    const paid = tx({ type: 'DIVIDEND', date: '2026-09-02', quantity: 6.4, price: 1.25, fee: 1.2, currency: 'USD' });
    const body = detectDueNotifications(base({ transactions: [tx({ quantity: 6.4 }), paid], notified: new Set([ledgerId('received', 'KMB', paid.id)]) })).due.find((d) => d.type === 'declared')!.message.payload.body;
    // 6.4 x 1.28 = 8.192 USD -> 7.4473 EUR, 15 % withheld (1.2 of 8.0) -> 6.33
    expect(body).toContain('about EUR 6.33');
  });

  it('declares nothing and compares nothing for a first-ever dividend (no history)', () => {
    const { due } = detectDueNotifications(base({ dividendEvents: [event({})] }));
    expect(due.find((d) => d.type === 'declared')!.message.payload.body).toBe('Ex-date 06-11-2026, pay 02-12-2026 · about EUR 7.45 for your 6.4 shares');
  });

  it('omits the pay date when the event has none', () => {
    const { due } = detectDueNotifications(base({ dividendEvents: [event({ payDate: undefined })] }));
    expect(due.find((d) => d.type === 'declared')!.message.payload.body).toMatch(/^Ex-date 06-11-2026 · about/);
  });

  it('falls back to the symbol without a name', () => {
    expect(detectDueNotifications(base({ names: {} })).due.map((d) => d.message.payload.title)).toEqual(['KMB declared $1.28 per share', 'KMB goes ex-dividend in 2 days (06-11-2026)']);
  });
});

describe('received', () => {
  const paid = (overrides: Partial<Transaction> = {}) => tx({ type: 'DIVIDEND', date: '2026-11-03', quantity: 6.4, price: 1.28, fee: 0.3, currency: 'USD', ...overrides });
  const received = (...extra: Transaction[]) => base({ dividendEvents: [], transactions: [tx({ quantity: 6.4 }), ...extra] });

  it('announces a booked dividend with the net amount in the base currency (broker rate first)', () => {
    const t = paid({ fxRate: 1.2 });
    const { due } = detectDueNotifications(received(t));
    expect(due).toHaveLength(1);
    expect(due[0]!.id).toBe(`received#KMB#${t.id}`);
    // 6.4 x 1.28 - 0.3 = 7.892 USD / 1.2
    expect(due[0]!.message.payload.title).toBe('Kimberly-Clark dividend received: EUR 6.58');
  });

  it('converts with the latest rate without a booked rate, and keeps the own currency when there is none', () => {
    expect(detectDueNotifications(received(paid())).due[0]!.message.payload.title).toBe('Kimberly-Clark dividend received: EUR 7.17');
    expect(detectDueNotifications(base({ fx: null, dividendEvents: [], transactions: [tx({ quantity: 6.4 }), paid()] })).due[0]!.message.payload.title).toBe('Kimberly-Clark dividend received: USD 7.89');
  });

  it('needs no conversion for a payment in the base currency', () => {
    const asml = [tx({ symbol: 'ASML', currency: 'EUR', quantity: 6.4 }), paid({ symbol: 'ASML', currency: 'EUR', fee: 0 })];
    const { due } = detectDueNotifications(base({ dividendEvents: [], transactions: asml, names: { ASML: 'ASML Holding N.V.' } }));
    expect(due[0]!.message.payload.title).toBe('ASML dividend received: EUR 8.19');
  });

  it('compares with the dividends you received before', () => {
    const history = [
      paid({ date: '2025-11-03', price: 1.21 }),
      paid({ date: '2026-02-03', price: 1.22 }),
      paid({ date: '2026-05-04', price: 1.25 }),
      paid({ date: '2026-08-03', price: 1.25 }),
    ];
    const now = paid();
    const { due } = detectDueNotifications(received(...history, now));
    const message = due.find((d) => d.id === `received#KMB#${now.id}`)!.message.payload;
    expect(message.body).toBe('$1.28 per share, +2.4 % vs last quarter, +5.8 % vs a year ago');
    expect(message.tag).toBe(`received:KMB:2026-11-03:${now.id}`);
  });

  it('is once per transaction', () => {
    const t = paid();
    expect(detectDueNotifications({ ...received(t), notified: new Set([ledgerId('received', 'KMB', t.id)]) }).due).toEqual([]);
  });

  it('records a back-dated payment silently instead of announcing it', () => {
    const old = paid({ date: '2026-10-20' });
    const fresh = paid({ date: '2026-10-21' });
    const result = detectDueNotifications(received(old, fresh));
    expect(result.silent).toEqual([{ type: 'received', symbol: 'KMB', eventKey: old.id }]);
    expect(result.due.map((d) => d.eventKey)).toEqual([fresh.id]);
  });

  it('announces payments of symbols that are no longer held', () => {
    const t = paid({ symbol: 'GONE' });
    expect(detectDueNotifications(base({ dividendEvents: [], transactions: [t] })).due.map((d) => d.symbol)).toEqual(['GONE']);
  });

  it('does nothing when the type is off', () => {
    const settings = { ...defaultNotificationSettings(), types: { exDividend: true, declared: true, received: false, earnings: false } };
    expect(detectDueNotifications({ ...received(paid()), settings }).due).toEqual([]);
  });
});

describe('ordering and failure', () => {
  it('orders by date, then symbol', () => {
    const events = [event({ symbol: 'AAA', exDate: '2026-11-08', payDate: undefined }), event({ symbol: 'ZZZ', exDate: '2026-11-05' }), event({ symbol: 'BBB', exDate: '2026-11-05' })];
    const transactions = ['AAA', 'ZZZ', 'BBB'].map((symbol) => tx({ symbol }));
    const { due } = detectDueNotifications(base({ dividendEvents: events, transactions, settings: { ...defaultNotificationSettings(), types: { exDividend: false, declared: true, received: false, earnings: false } } }));
    expect(due.map((d) => d.symbol)).toEqual(['BBB', 'ZZZ', 'AAA']);
  });

  it('throws when the transactions cannot be replayed', () => {
    expect(() => detectDueNotifications(base({ transactions: [tx({ type: 'SELL', quantity: 5 })] }))).toThrow();
  });
});

describe('baselineEntries', () => {
  const transactions = [tx({ quantity: 6.4 }), tx({ type: 'DIVIDEND', date: '2024-05-01', price: 1 }), tx({ type: 'DIVIDEND', date: '2026-11-03', price: 1.28, symbol: 'OLD' })];
  const events = [...HISTORY, event({}), event({ symbol: 'MSFT', exDate: '2026-11-20' })];

  it('marks every dividend transaction and every upcoming event of a held symbol', () => {
    const entries = baselineEntries({ today: TODAY, transactions, dividendEvents: events, types: ['declared', 'received'] });
    expect(entries.filter((e) => e.type === 'received').map((e) => e.symbol).sort((a, b) => a.localeCompare(b))).toEqual(['KMB', 'OLD']);
    expect(entries.filter((e) => e.type === 'declared')).toEqual([{ type: 'declared', symbol: 'KMB', eventKey: '2026-11-06' }]);
  });

  it('never baselines ex-dividend reminders and honours the requested types', () => {
    expect(baselineEntries({ today: TODAY, transactions, dividendEvents: events, types: ['exDividend'] })).toEqual([]);
    expect(baselineEntries({ today: TODAY, transactions, dividendEvents: events, types: ['declared'] }).every((e) => e.type === 'declared')).toBe(true);
    expect(baselineEntries({ today: TODAY, transactions, dividendEvents: events, types: ['received'] }).every((e) => e.type === 'received')).toBe(true);
  });

  it('is exactly what keeps the first run quiet', () => {
    const entries = baselineEntries({ today: TODAY, transactions, dividendEvents: events, types: ['declared', 'received'] });
    const notified = new Set(entries.map((e) => ledgerId(e.type, e.symbol, e.eventKey)));
    const { due, silent } = detectDueNotifications(base({ transactions, dividendEvents: events, notified }));
    expect(due.map((d) => d.type)).toEqual(['exDividend']);
    expect(silent).toEqual([]);
  });
});

describe('current holdings', () => {
  const sell = (symbol: string, quantity: number, date = '2026-02-01') => tx({ symbol, type: 'SELL', quantity, date });

  it('keeps what is held, and sets sold-out symbols and sub-dust leftovers apart', () => {
    const transactions = [
      tx({ symbol: 'KEEP', quantity: 3 }),
      tx({ symbol: 'GONE', quantity: 5 }),
      sell('GONE', 5),
      tx({ symbol: 'LEFT', quantity: 5 }),
      sell('LEFT', 5 - 1e-7),
      tx({ symbol: 'TINY', quantity: 2 }),
      sell('TINY', 2 - 1e-5),
      tx({ symbol: 'LATER', quantity: 1, date: '2027-01-01' }),
      tx({ symbol: customSymbol('house'), quantity: 1 }),
    ];
    expect(heldQuantities(transactions, TODAY).get('TINY')).toBeCloseTo(1e-5, 9);
    expect(currentHoldings(transactions, TODAY)).toEqual({ held: ['KEEP', 'TINY'], former: ['GONE', 'LEFT'] });
  });

  it('is empty without transactions', () => {
    expect(currentHoldings([], TODAY)).toEqual({ held: [], former: [] });
  });
});
