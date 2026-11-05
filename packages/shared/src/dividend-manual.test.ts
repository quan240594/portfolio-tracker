import { describe, expect, it } from 'vitest';
import { MANUAL_DIVIDEND_ENTITY, addManualDividendSchema, manualDividendEvent, manualDividendKeys, type ManualDividend } from './dividend-manual.js';

describe('addManualDividendSchema', () => {
  it('accepts the minimum and normalises the symbol and currency', () => {
    expect(addManualDividendSchema.parse({ symbol: ' hesm ', exDate: '2026-11-05' })).toEqual({ symbol: 'HESM', exDate: '2026-11-05' });
    expect(addManualDividendSchema.parse({ symbol: 'HESM', exDate: '2026-11-05', payDate: '2026-11-13', amount: '0.7', currency: 'usd' })).toEqual({ symbol: 'HESM', exDate: '2026-11-05', payDate: '2026-11-13', amount: 0.7, currency: 'USD' });
  });

  it('treats empty optional fields as absent', () => {
    expect(addManualDividendSchema.parse({ symbol: 'HESM', exDate: '2026-11-05', payDate: '', amount: '', currency: null })).toEqual({ symbol: 'HESM', exDate: '2026-11-05' });
  });

  it('rejects bad dates, amounts and currencies', () => {
    expect(addManualDividendSchema.safeParse({ symbol: 'HESM', exDate: '2026-13-05' }).success).toBe(false);
    expect(addManualDividendSchema.safeParse({ symbol: 'HESM', exDate: '2026-11-05', amount: -1 }).success).toBe(false);
    expect(addManualDividendSchema.safeParse({ symbol: 'HESM', exDate: '2026-11-05', currency: 'DOLLAR' }).success).toBe(false);
    expect(addManualDividendSchema.safeParse({ exDate: '2026-11-05' }).success).toBe(false);
  });
});

describe('manual dividend storage', () => {
  it('is keyed per user, symbol and ex-date', () => {
    expect(manualDividendKeys.item('u1', 'HESM', '2026-11-05')).toEqual({ PK: 'USER#u1', SK: 'MDIV#HESM#2026-11-05' });
    expect(MANUAL_DIVIDEND_ENTITY).toBe('MANUAL_DIVIDEND');
  });

  it('turns an entry into the declared event the calendar works with', () => {
    const entry: ManualDividend = { userId: 'u1', symbol: 'HESM', exDate: '2026-11-05', payDate: '2026-11-13', amount: 0.7, currency: 'USD', source: 'manual', declared: true, enteredAt: '2026-11-05T09:00:00.000Z' };
    expect(manualDividendEvent(entry)).toEqual({ symbol: 'HESM', exDate: '2026-11-05', payDate: '2026-11-13', amount: 0.7, currency: 'USD', source: 'manual', declared: true });
    const { payDate: _payDate, ...noPay } = entry;
    expect(manualDividendEvent(noPay)).not.toHaveProperty('payDate');
  });
});
