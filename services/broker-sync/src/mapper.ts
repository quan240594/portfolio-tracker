/**
 * Trading 212 records -> our Transaction model. Pure: symbol resolution and FX fallbacks are prepared by the caller.
 *
 * Conventions (see docs/architecture.md): price/fee in the instrument's major currency (GBX -> GBP), `fxRate` =
 * instrument-currency units per 1 EUR and only set for EUR accounts when it agrees with the trade amounts.
 */
import {
  T212_IMPORT_ID,
  T212_TRANSACTION_ID_PREFIX,
  normalizeCurrency,
  resolveFxRate,
  roundTo,
  sumFees,
  type SymbolMapping,
  type Transaction,
  type UnmappedInstrument,
} from '@portfolio/shared';
import type { HistoricalOrder, HistoryDividend, T212Instrument } from './t212/schemas.js';

const BASE_CURRENCY = 'EUR';

/** Observed account->instrument rates (instrument currency units per 1 account-currency unit), by currency. */
export class RateBook {
  private readonly rates = new Map<string, { at: number; rate: number }[]>();

  add(currency: string, at: number, rate: number): void {
    const list = this.rates.get(currency) ?? [];
    list.push({ at, rate });
    this.rates.set(currency, list);
  }

  nearest(currency: string, at: number): number | undefined {
    const list = this.rates.get(currency);
    if (!list?.length) return undefined;
    return list.reduce((best, r) => (Math.abs(r.at - at) < Math.abs(best.at - at) ? r : best), list[0]!).rate;
  }
}

/** Skipped records grouped by instrument and reason; the list shown to the user. */
export class SkipLog {
  private readonly entries = new Map<string, UnmappedInstrument>();
  total = 0;

  add(instrument: T212Instrument, reason: string): void {
    this.total++;
    const key = `${instrument.ticker}|${reason}`;
    const known = this.entries.get(key);
    if (known) known.count++;
    else {
      this.entries.set(key, {
        ticker: instrument.ticker,
        ...(instrument.isin ? { isin: instrument.isin } : {}),
        ...(instrument.name ? { name: instrument.name } : {}),
        currency: instrument.currency,
        reason,
        count: 1,
      });
    }
  }

  list(): UnmappedInstrument[] {
    return [...this.entries.values()].sort((a, b) => a.ticker.localeCompare(b.ticker) || a.reason.localeCompare(b.reason));
  }
}

export interface MapContext {
  userId: string;
  portfolioId: string;
  /** Mapping of every instrument ticker occurring in the records. */
  symbols: ReadonlyMap<string, SymbolMapping>;
  skipped: SkipLog;
}

/** Ids end up in sort keys and URLs: keep them to a safe alphabet. */
const safeId = (s: string) => s.replaceAll(/[^A-Za-z0-9._-]/g, '_');

function parseTime(value: string): { iso: string; ms: number } | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : { iso: new Date(ms).toISOString(), ms };
}

const withBase = (ctx: MapContext, id: string, time: { iso: string }, instrument: T212Instrument, symbol: string) => ({
  id,
  userId: ctx.userId,
  portfolioId: ctx.portfolioId,
  date: time.iso.slice(0, 10),
  symbol,
  note: `T212 ${instrument.ticker}`,
  importId: T212_IMPORT_ID,
  // The execution time keeps same-day transactions in order and makes re-syncs byte-identical.
  createdAt: time.iso,
});

function mappedSymbol(ctx: MapContext, instrument: T212Instrument): string | undefined {
  const mapping = ctx.symbols.get(instrument.ticker);
  if (mapping?.ok) return mapping.symbol;
  ctx.skipped.add(instrument, mapping && !mapping.ok ? mapping.reason : 'NO_PATTERN');
  return undefined;
}

/** Fill types that hand out shares for free: imported as a BUY at the reported price (T212 reports 0 for spin-offs). */
const FREE_SHARE_FILLS = new Set(['SPIN_OFF', 'STOCK_DISTRIBUTION', 'CUSTOM_STOCK_DISTRIBUTION', 'STOCK_DIVIDENDS', 'SCRIP_STOCK_DIVIDENDS']);
export const STOCK_SPLIT_FILL = 'STOCK_SPLIT';

/** Trading 212 quotes the rate in the instrument's quoted currency, i.e. pence per EUR for GBX instruments. */
const reportedRate = (rate: number | undefined, divisor: number) => (rate === undefined ? undefined : rate / divisor);

export interface MappedOrder {
  transaction: Transaction;
  /** Observed instrument-per-account rate, when the fill's FX data is consistent. */
  rate?: { currency: string; at: number; value: number };
}

type FillKind = { kind: 'ignore' } | { kind: 'skip'; reason: string } | { kind: 'ok'; side: 'BUY' | 'SELL'; distribution: boolean };

/** Which fills become transactions: trades, and BUY-side share distributions. Splits are mapSplits' job. */
function classifyFill(order: HistoricalOrder['order'], fill: NonNullable<HistoricalOrder['fill']>): FillKind {
  if (fill.type === STOCK_SPLIT_FILL) return { kind: 'ignore' };
  const distribution = fill.type !== undefined && FREE_SHARE_FILLS.has(fill.type);
  if (fill.type !== undefined && fill.type !== 'TRADE' && !distribution) return { kind: 'skip', reason: `UNSUPPORTED_FILL_${fill.type}` };
  const side = order.side.toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return { kind: 'skip', reason: 'UNSUPPORTED_SIDE' };
  if (distribution && side !== 'BUY') return { kind: 'skip', reason: `UNSUPPORTED_FILL_${fill.type}` };
  return { kind: 'ok', side, distribution };
}

/**
 * A filled order -> BUY/SELL. Orders without a fill (cancelled, rejected, pending) are ignored. Share distributions
 * are imported as BUYs, stock splits are handled by mapSplits, other fill types are skipped and reported.
 */
export function mapOrder(item: HistoricalOrder, ctx: MapContext): MappedOrder | undefined {
  const { order, fill } = item;
  if (!fill || fill.quantity === 0) return undefined;
  const { instrument } = order;
  const kind = classifyFill(order, fill);
  if (kind.kind === 'ignore') return undefined;
  if (kind.kind === 'skip') {
    ctx.skipped.add(instrument, kind.reason);
    return undefined;
  }
  const time = parseTime(fill.filledAt);
  if (!time) {
    ctx.skipped.add(instrument, 'INVALID_TIME');
    return undefined;
  }
  const symbol = mappedSymbol(ctx, instrument);
  if (symbol === undefined) return undefined;

  const currency = normalizeCurrency(instrument.currency);
  const price = roundTo(fill.price / currency.divisor, 8);
  const quantity = roundTo(Math.abs(fill.quantity), 8);
  const wallet = fill.walletImpact;
  const accountCurrency = wallet?.currency.toUpperCase();
  const rate =
    wallet && accountCurrency !== currency.currency
      ? resolveFxRate({ reported: reportedRate(wallet.fxRate, currency.divisor), accountAmount: Math.abs(wallet.netValue ?? 0), localAmount: quantity * price })
      : undefined;
  const taxes = (wallet?.taxes ?? []).map((t) => ({ amount: t.quantity, currency: t.currency ?? accountCurrency ?? currency.currency }));
  const { fee } = sumFees(taxes, currency.currency, accountCurrency ?? currency.currency, rate);

  const transaction: Transaction = {
    ...withBase(ctx, `${T212_TRANSACTION_ID_PREFIX}${safeId(order.id)}-${safeId(fill.id)}`, time, instrument, symbol),
    ...(kind.distribution ? { note: `T212 ${instrument.ticker} ${fill.type!.toLowerCase().replaceAll('_', ' ')}` } : {}),
    type: kind.side,
    quantity,
    price,
    fee,
    currency: currency.currency,
  };
  if (rate !== undefined && accountCurrency === BASE_CURRENCY) transaction.fxRate = rate;
  return {
    transaction,
    ...(rate === undefined || !accountCurrency ? {} : { rate: { currency: currency.currency, at: time.ms, value: rate } }),
  };
}

/**
 * Stock splits arrive as a SELL of the old shares and a BUY of the new ones at the same instant, both valued at the
 * market price. Importing them as trades would realise a bogus gain and reset the cost basis, so each split becomes
 * one zero-cost BUY of the net share increase: the total cost is unchanged and the average cost per share drops
 * accordingly. A net decrease (reverse split) cannot be expressed without a cost basis and is reported as skipped.
 * The id derives from instrument + time (not from the fill ids), so a re-sync that sees only one half of a pair
 * converges to the same transaction once both halves are read.
 */
export function mapSplits(items: readonly HistoricalOrder[], ctx: MapContext): Transaction[] {
  const groups = new Map<string, { instrument: T212Instrument; at: { iso: string; ms: number }; net: number }>();
  for (const { order, fill } of items) {
    if (fill?.type !== STOCK_SPLIT_FILL) continue;
    const time = parseTime(fill.filledAt);
    if (!time) {
      ctx.skipped.add(order.instrument, 'INVALID_TIME');
      continue;
    }
    const key = `${order.instrument.ticker}|${time.ms}`;
    const group = groups.get(key) ?? { instrument: order.instrument, at: time, net: 0 };
    group.net += (order.side.toUpperCase() === 'SELL' ? -1 : 1) * Math.abs(fill.quantity);
    groups.set(key, group);
  }
  const out: Transaction[] = [];
  for (const [key, { instrument, at, net }] of groups) {
    const symbol = mappedSymbol(ctx, instrument);
    if (symbol === undefined) continue;
    if (net <= 0) {
      ctx.skipped.add(instrument, `UNSUPPORTED_FILL_${STOCK_SPLIT_FILL}`);
      continue;
    }
    out.push({
      ...withBase(ctx, `${T212_TRANSACTION_ID_PREFIX}split-${safeId(key)}`, at, instrument, symbol),
      note: `T212 ${instrument.ticker} stock split`,
      type: 'BUY',
      quantity: roundTo(net, 8),
      price: 0,
      fee: 0,
      currency: normalizeCurrency(instrument.currency).currency,
    });
  }
  return out;
}

export interface DividendContext extends MapContext {
  rates: RateBook;
  /** Latest instrument-per-EUR rates (ECB), only usable for EUR accounts. */
  fallbackRates: Readonly<Record<string, number>>;
}

function dividendRate(item: HistoryDividend, currency: string, at: number, ctx: DividendContext): number | undefined {
  const observed = ctx.rates.nearest(currency, at);
  if (observed !== undefined) return observed;
  return item.currency.toUpperCase() === BASE_CURRENCY ? ctx.fallbackRates[currency] : undefined;
}

/**
 * A dividend payment -> DIVIDEND (quantity eligible, price gross per share, fee = withholding tax).
 *
 * Trading 212 reports the net amount in the account currency only, so the withholding tax is derived as
 * gross - net (net converted at an observed/ECB rate). The same rate is stored as `fxRate`, which makes the net
 * received in EUR exactly the reported amount regardless of how accurate the rate is.
 */
export function mapDividend(item: HistoryDividend, ctx: DividendContext): Transaction | undefined {
  const { instrument } = item;
  if (item.quantity <= 0 || item.amount <= 0) {
    ctx.skipped.add(instrument, 'NON_POSITIVE_DIVIDEND');
    return undefined;
  }
  const time = parseTime(item.paidOn);
  if (!time) {
    ctx.skipped.add(instrument, 'INVALID_TIME');
    return undefined;
  }
  const symbol = mappedSymbol(ctx, instrument);
  if (symbol === undefined) return undefined;

  const currency = normalizeCurrency(item.tickerCurrency ?? instrument.currency);
  const accountCurrency = item.currency.toUpperCase();
  const price = roundTo(item.grossAmountPerShare / currency.divisor, 8);
  const gross = item.quantity * price;
  const sameCurrency = accountCurrency === currency.currency;
  const rate = sameCurrency ? undefined : dividendRate(item, currency.currency, time.ms, ctx);
  if (!sameCurrency && rate === undefined) {
    ctx.skipped.add(instrument, 'NO_FX_RATE');
    return undefined;
  }
  const net = sameCurrency ? item.amount : item.amount * rate!;
  const transaction: Transaction = {
    ...withBase(ctx, `${T212_TRANSACTION_ID_PREFIX}div-${safeId(item.reference)}`, time, instrument, symbol),
    type: 'DIVIDEND',
    quantity: roundTo(item.quantity, 8),
    price,
    fee: Math.max(0, roundTo(gross - net, 6)),
    currency: currency.currency,
  };
  if (rate !== undefined && accountCurrency === BASE_CURRENCY) transaction.fxRate = roundTo(rate, 6);
  return transaction;
}
