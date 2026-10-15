import { describe, expect, it } from 'vitest';
import { mapT212Symbol, type SymbolMapping } from '@portfolio/shared';
import { RateBook, SkipLog, mapDividend, mapOrder, mapSplits, type DividendContext } from './mapper.js';
import { dividend, order } from './testing/fixtures.js';

const symbolsFor = (...tickers: { ticker: string; currency: string; isin?: string }[]) =>
  new Map<string, SymbolMapping>(tickers.map((t) => [t.ticker, mapT212Symbol(t)]));

const makeCtx = (extra: Partial<DividendContext> = {}): DividendContext => ({
  userId: 'u1',
  portfolioId: 'p1',
  symbols: symbolsFor(
    { ticker: 'AAPL_US_EQ', currency: 'USD' },
    { ticker: 'ASMLa_EQ', currency: 'EUR' },
    { ticker: 'VUSAl_EQ', currency: 'GBX' },
    { ticker: 'VWRL', currency: 'EUR' },
  ),
  skipped: new SkipLog(),
  rates: new RateBook(),
  fallbackRates: {},
  ...extra,
});

describe('mapOrder', () => {
  it('maps a USD buy on a EUR account with the broker fx rate and converted fees', () => {
    const ctx = makeCtx();
    const mapped = mapOrder(
      order({ price: 100, quantity: 2, fxRate: 1.09, netValue: 183.9, taxes: [{ name: 'CURRENCY_CONVERSION_FEE', quantity: 0.28, currency: 'EUR' }] }),
      ctx,
    )!;
    expect(mapped.transaction).toEqual({
      id: 't212-1-10',
      userId: 'u1',
      portfolioId: 'p1',
      date: '2024-03-05',
      type: 'BUY',
      symbol: 'AAPL',
      quantity: 2,
      price: 100,
      fee: 0.3052,
      currency: 'USD',
      note: 'T212 AAPL_US_EQ',
      importId: 'trading212',
      createdAt: '2024-03-05T14:30:00.000Z',
      fxRate: 1.09,
    });
    expect(mapped.rate).toEqual({ currency: 'USD', at: Date.parse('2024-03-05T14:30:00.000Z'), value: 1.09 });
  });

  it('accepts an fx rate reported in the inverse direction', () => {
    const mapped = mapOrder(order({ price: 100, quantity: 2, fxRate: 1 / 1.09, netValue: 183.5 }), makeCtx())!;
    expect(mapped.transaction.fxRate).toBeCloseTo(1.09, 3);
  });

  it('drops an fx rate that contradicts the amounts (ECB fixing applies instead)', () => {
    const mapped = mapOrder(order({ fxRate: 2.5, netValue: 183.5 }), makeCtx())!;
    expect(mapped.transaction.fxRate).toBeUndefined();
    expect(mapped.rate).toBeUndefined();
  });

  it('sets no fxRate for non-EUR accounts but still converts fees with the rate', () => {
    const mapped = mapOrder(
      order({ walletCurrency: 'GBP', price: 100, quantity: 2, fxRate: 1.27, netValue: 157.5, taxes: [{ quantity: 1, currency: 'GBP' }] }),
      makeCtx(),
    )!;
    expect(mapped.transaction.fxRate).toBeUndefined();
    expect(mapped.transaction.fee).toBe(1.27);
    expect(mapped.rate?.value).toBe(1.27);
  });

  it('sets no fxRate when the instrument is traded in the account currency', () => {
    const mapped = mapOrder(
      order({ ticker: 'ASMLa_EQ', currency: 'EUR', isin: 'NL0010273215', price: 700, quantity: 1, netValue: 700, taxes: [{ quantity: 1.5, currency: 'EUR' }] }),
      makeCtx(),
    )!;
    expect(mapped.transaction).toMatchObject({ symbol: 'ASML.AS', fee: 1.5, currency: 'EUR' });
    expect(mapped.transaction.fxRate).toBeUndefined();
    expect(mapped.rate).toBeUndefined();
  });

  it('converts GBX prices to GBP and keeps GBP stamp duty as is (the rate is quoted in pence per EUR)', () => {
    const mapped = mapOrder(
      order({
        ticker: 'VUSAl_EQ',
        currency: 'GBX',
        isin: 'IE00B3XXRP09',
        price: 8000,
        quantity: 1,
        fxRate: 86,
        netValue: 93.5,
        taxes: [{ name: 'STAMP_DUTY', quantity: 0.4, currency: 'GBP' }],
      }),
      makeCtx(),
    )!;
    expect(mapped.transaction).toMatchObject({ symbol: 'VUSA.L', currency: 'GBP', price: 80, fee: 0.4, fxRate: 0.86 });
  });

  it('uses the account currency for taxes without a currency and handles a missing wallet impact', () => {
    const noCurrency = mapOrder(order({ fxRate: 1.09, netValue: 183.5, taxes: [{ quantity: 0.2 }] }), makeCtx())!;
    expect(noCurrency.transaction.fee).toBeCloseTo(0.218, 6);
    const noWallet = mapOrder(order({ noWallet: true }), makeCtx())!;
    expect(noWallet.transaction).toMatchObject({ fee: 0 });
    expect(noWallet.transaction.fxRate).toBeUndefined();
  });

  it('leaves fees in another currency out when no rate is known', () => {
    const mapped = mapOrder(order({ netValue: 183.5, taxes: [{ quantity: 0.2, currency: 'EUR' }] }), makeCtx())!;
    expect(mapped.transaction.fee).toBe(0);
  });

  it('maps sells and uses absolute quantities', () => {
    const mapped = mapOrder(order({ side: 'SELL', quantity: -3 }), makeCtx())!;
    expect(mapped.transaction).toMatchObject({ type: 'SELL', quantity: 3 });
  });

  it('gives partial fills of one order distinct ids and sanitizes ids', () => {
    const a = mapOrder(order({ id: 7, fillId: 1 }), makeCtx())!;
    const b = mapOrder(order({ id: 7, fillId: 2 }), makeCtx())!;
    expect(a.transaction.id).not.toBe(b.transaction.id);
    expect(mapOrder(order({ id: 'a/b#c', fillId: 'x y' }), makeCtx())!.transaction.id).toBe('t212-a_b_c-x_y');
  });

  it('ignores orders without a fill (cancelled, rejected, pending) and empty fills', () => {
    const ctx = makeCtx();
    expect(mapOrder(order({ status: 'CANCELLED', noFill: true }), ctx)).toBeUndefined();
    expect(mapOrder(order({ quantity: 0 }), ctx)).toBeUndefined();
    expect(ctx.skipped.total).toBe(0);
  });

  it('keeps the fill of a partially filled order that was cancelled', () => {
    expect(mapOrder(order({ status: 'CANCELLED' }), makeCtx())).toBeDefined();
  });

  it('skips corporate-action fills, unknown sides, bad times and unmapped instruments with a reason', () => {
    const ctx = makeCtx();
    expect(mapOrder(order({ type: 'EQUITY_RIGHTS' }), ctx)).toBeUndefined();
    expect(mapOrder(order({ side: 'SHORT' }), ctx)).toBeUndefined();
    expect(mapOrder(order({ filledAt: 'garbage' }), ctx)).toBeUndefined();
    expect(mapOrder(order({ ticker: 'VWRL', currency: 'EUR', isin: 'IE00B3RBWM25' }), ctx)).toBeUndefined();
    expect(mapOrder(order({ ticker: 'UNKNOWN_EQ' }), ctx)).toBeUndefined();
    expect(ctx.skipped.list().map((s) => [s.ticker, s.reason])).toEqual([
      ['AAPL_US_EQ', 'INVALID_TIME'],
      ['AAPL_US_EQ', 'UNSUPPORTED_FILL_EQUITY_RIGHTS'],
      ['AAPL_US_EQ', 'UNSUPPORTED_SIDE'],
      ['UNKNOWN_EQ', 'NO_PATTERN'],
      ['VWRL', 'AMBIGUOUS_LISTING'],
    ]);
    expect(ctx.skipped.total).toBe(5);
  });
});

describe('share distributions', () => {
  it('imports a spin-off as a zero-cost buy', () => {
    const mapped = mapOrder(order({ type: 'SPIN_OFF', price: 0, quantity: 3.5, netValue: 0, fxRate: 1, walletCurrency: 'EUR' }), makeCtx())!;
    expect(mapped.transaction).toMatchObject({ type: 'BUY', quantity: 3.5, price: 0, fee: 0, note: 'T212 AAPL_US_EQ spin off' });
    expect(mapped.transaction.fxRate).toBeUndefined();
  });

  it('skips a distribution that is not an addition of shares', () => {
    const ctx = makeCtx();
    expect(mapOrder(order({ type: 'STOCK_DIVIDENDS', side: 'SELL' }), ctx)).toBeUndefined();
    expect(ctx.skipped.list().map((s) => s.reason)).toEqual(['UNSUPPORTED_FILL_STOCK_DIVIDENDS']);
  });
});

describe('mapSplits', () => {
  const split = (o: Parameters<typeof order>[0] = {}) => order({ type: 'STOCK_SPLIT', filledAt: '2025-11-17T07:42:34.000Z', ...o });

  it('turns the SELL/BUY pair of a split into one zero-cost buy of the net increase', () => {
    const ctx = makeCtx();
    const out = mapSplits(
      [
        split({ id: 1, fillId: 11, side: 'SELL', quantity: -0.5, price: 1000 }),
        split({ id: 2, fillId: 12, side: 'BUY', quantity: 5, price: 100 }),
        order({ id: 3 }),
      ],
      ctx,
    );
    expect(out).toEqual([
      {
        id: 't212-split-AAPL_US_EQ_1763365354000',
        userId: 'u1',
        portfolioId: 'p1',
        date: '2025-11-17',
        symbol: 'AAPL',
        note: 'T212 AAPL_US_EQ stock split',
        importId: 'trading212',
        createdAt: '2025-11-17T07:42:34.000Z',
        type: 'BUY',
        quantity: 4.5,
        price: 0,
        fee: 0,
        currency: 'USD',
      },
    ]);
  });

  it('keeps the id independent of which half of the pair is seen', () => {
    const buyOnly = mapSplits([split({ id: 2, fillId: 12, side: 'BUY', quantity: 5 })], makeCtx());
    const sellOnly = mapSplits([split({ id: 1, fillId: 11, side: 'SELL', quantity: -0.5 })], makeCtx());
    expect(buyOnly[0]!.id).toBe('t212-split-AAPL_US_EQ_1763365354000');
    expect(sellOnly).toEqual([]);
  });

  it('reports reverse splits, unmapped instruments and bad times instead of guessing', () => {
    const ctx = makeCtx();
    const out = mapSplits(
      [
        split({ side: 'SELL', quantity: -5, price: 100 }),
        split({ side: 'BUY', quantity: 0.5, price: 1000, ticker: 'ASMLa_EQ', currency: 'EUR', isin: 'NL0010273215' }),
        split({ ticker: 'UNKNOWN_EQ' }),
        split({ filledAt: 'garbage' }),
        order({ type: 'TRADE' }),
        order({ noFill: true }),
      ],
      ctx,
    );
    expect(out.map((t) => t.symbol)).toEqual(['ASML.AS']);
    expect(ctx.skipped.list().map((s) => [s.ticker, s.reason])).toEqual([
      ['AAPL_US_EQ', 'INVALID_TIME'],
      ['AAPL_US_EQ', 'UNSUPPORTED_FILL_STOCK_SPLIT'],
      ['UNKNOWN_EQ', 'NO_PATTERN'],
    ]);
  });
});

describe('mapDividend', () => {
  it('derives the withholding tax so the net amount in EUR is exactly the reported one', () => {
    const ctx = makeCtx();
    ctx.rates.add('USD', Date.parse('2024-05-10T00:00:00Z'), 1.08);
    ctx.rates.add('USD', Date.parse('2023-01-01T00:00:00Z'), 1.5);
    const t = mapDividend(dividend({ quantity: 10, grossAmountPerShare: 0.25, amount: 1.6 }), ctx)!;
    expect(t).toMatchObject({
      id: 't212-div-ref-1',
      type: 'DIVIDEND',
      symbol: 'AAPL',
      quantity: 10,
      price: 0.25,
      currency: 'USD',
      date: '2024-05-16',
      fxRate: 1.08,
      importId: 'trading212',
    });
    expect(t.fee).toBeCloseTo(2.5 - 1.6 * 1.08, 6);
    expect((t.quantity * t.price - t.fee) / t.fxRate!).toBeCloseTo(1.6, 6);
  });

  it('falls back to the stored ECB rate for EUR accounts and skips when no rate exists', () => {
    const t = mapDividend(dividend(), makeCtx({ fallbackRates: { USD: 1.1 } }))!;
    expect(t.fxRate).toBe(1.1);
    const ctx = makeCtx();
    expect(mapDividend(dividend(), ctx)).toBeUndefined();
    expect(ctx.skipped.list()[0]).toMatchObject({ reason: 'NO_FX_RATE' });
    // The ECB table is relative to EUR, so it is not used for other account currencies.
    expect(mapDividend(dividend({ accountCurrency: 'GBP' }), makeCtx({ fallbackRates: { USD: 1.1 } }))).toBeUndefined();
  });

  it('needs no rate for dividends in the account currency and clamps a negative withholding to zero', () => {
    const t = mapDividend(
      dividend({ ticker: 'ASMLa_EQ', isin: 'NL0010273215', currency: 'EUR', quantity: 2, grossAmountPerShare: 5, amount: 8.5 }),
      makeCtx(),
    )!;
    expect(t).toMatchObject({ symbol: 'ASML.AS', fee: 1.5, currency: 'EUR' });
    expect(t.fxRate).toBeUndefined();
    const over = mapDividend(dividend({ ticker: 'ASMLa_EQ', currency: 'EUR', quantity: 1, grossAmountPerShare: 1, amount: 1.2 }), makeCtx())!;
    expect(over.fee).toBe(0);
  });

  it('converts pence-denominated dividends', () => {
    const ctx = makeCtx();
    ctx.rates.add('GBP', 0, 0.86);
    const t = mapDividend(dividend({ ticker: 'VUSAl_EQ', isin: 'IE00B3XXRP09', currency: 'GBX', quantity: 10, grossAmountPerShare: 30, amount: 3.4 }), ctx)!;
    expect(t).toMatchObject({ symbol: 'VUSA.L', currency: 'GBP', price: 0.3 });
    expect(t.fee).toBeCloseTo(3 - 3.4 * 0.86, 6);
  });

  it('skips non-positive, invalid and unmapped dividends', () => {
    const ctx = makeCtx();
    expect(mapDividend(dividend({ amount: -1 }), ctx)).toBeUndefined();
    expect(mapDividend(dividend({ quantity: 0 }), ctx)).toBeUndefined();
    expect(mapDividend(dividend({ paidOn: 'nope' }), ctx)).toBeUndefined();
    expect(mapDividend(dividend({ ticker: 'UNKNOWN_EQ' }), ctx)).toBeUndefined();
    expect(ctx.skipped.list().map((s) => s.reason)).toEqual(['INVALID_TIME', 'NON_POSITIVE_DIVIDEND', 'NO_PATTERN']);
  });

  it('maps bonus and unknown dividend types like ordinary ones', () => {
    const ctx = makeCtx({ fallbackRates: { USD: 1.1 } });
    expect(mapDividend(dividend({ type: 'BONUS', reference: 'b' }), ctx)).toBeDefined();
    expect(mapDividend(dividend({ type: 'SOMETHING_NEW', reference: 'n' }), ctx)).toBeDefined();
  });
});

describe('RateBook / SkipLog', () => {
  it('picks the nearest observation and returns undefined for unknown currencies', () => {
    const book = new RateBook();
    book.add('USD', 100, 1);
    book.add('USD', 200, 2);
    expect(book.nearest('USD', 190)).toBe(2);
    expect(book.nearest('USD', 120)).toBe(1);
    expect(book.nearest('CHF', 1)).toBeUndefined();
  });

  it('returns undefined instead of throwing when a currency has no observations left', () => {
    const book = new RateBook();
    (book as unknown as { rates: Map<string, unknown[]> }).rates.set('USD', []);
    expect(book.nearest('USD', 1)).toBeUndefined();
  });

  it('groups skips and keeps optional fields out when absent', () => {
    const log = new SkipLog();
    log.add({ ticker: 'X', currency: 'USD' }, 'R');
    log.add({ ticker: 'X', currency: 'USD' }, 'R');
    log.add({ ticker: 'Y', currency: 'USD', isin: 'US1', name: 'Y Inc' }, 'R');
    expect(log.list()).toEqual([
      { ticker: 'X', currency: 'USD', reason: 'R', count: 2 },
      { ticker: 'Y', isin: 'US1', name: 'Y Inc', currency: 'USD', reason: 'R', count: 1 },
    ]);
  });
});
