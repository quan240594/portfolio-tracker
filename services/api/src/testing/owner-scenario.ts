import type { EodPrice, Quote, Transaction } from '@portfolio/shared';
import { createHandler } from '../lambda/handler.js';
import { fakeDeps, portfolio, txn } from './fakes.js';

/**
 * The owner's pattern: a dozen holdings in EUR, USD and GBP, monthly purchases over 18 months, a provider window of one year, London
 * lines of which two are quoted in USD (the price service stores every London close as pence: 1/100 and labelled GBP), and one
 * holding without any history. The prices only ever rise, so the value can never be below what was paid.
 */
export const TODAY = '2026-06-15';
const WINDOW_START = '2025-06-10';
const USD = 1.1;
const GBP = 0.85;

export interface Line {
  symbol: string;
  currency: 'EUR' | 'USD' | 'GBP';
  /** Price per unit in the line's currency on day 0 (major units). */
  base: number;
  /** How the provider's closes are stored for this line: in major units, or as the London pence assumption stores a USD price. */
  stored: 'major' | 'london-usd' | 'none';
}

export const LINES: Line[] = [
  { symbol: 'VWRL.AS', currency: 'EUR', base: 100, stored: 'major' },
  { symbol: 'ASML.AS', currency: 'EUR', base: 600, stored: 'major' },
  { symbol: 'ADB.DE', currency: 'EUR', base: 40, stored: 'major' },
  { symbol: 'FWRA.MI', currency: 'EUR', base: 8, stored: 'none' },
  { symbol: 'AAPL', currency: 'USD', base: 150, stored: 'major' },
  { symbol: 'AMZN', currency: 'USD', base: 170, stored: 'major' },
  { symbol: 'APP', currency: 'USD', base: 80, stored: 'major' },
  { symbol: 'MSFT', currency: 'USD', base: 300, stored: 'major' },
  { symbol: 'SMGB.L', currency: 'GBP', base: 70, stored: 'major' },
  { symbol: 'IITU.L', currency: 'USD', base: 52, stored: 'london-usd' },
  { symbol: 'GLDW.L', currency: 'USD', base: 60, stored: 'london-usd' },
  { symbol: 'EFX', currency: 'USD', base: 220, stored: 'major' },
];

const dayMs = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const START = Date.parse('2025-01-15T00:00:00Z');
const dayIndex = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - START) / dayMs);
export const price = (line: Line, date: string) => line.base * (1 + 0.0004 * dayIndex(date));
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= Date.parse(`${to}T00:00:00Z`); ms += dayMs) out.push(isoDay(ms));
  return out;
};
export const rateOf = (currency: string) => ({ EUR: 1, USD, GBP })[currency]!;

export function transactions(): Transaction[] {
  const purchases = ['2025-01-15', '2025-02-17', '2025-03-17', '2025-04-15', '2025-05-15', '2025-06-16', '2025-07-15', '2025-08-15', '2025-09-15', '2025-10-15', '2025-11-17', '2025-12-15', '2026-01-15', '2026-02-16', '2026-03-16', '2026-04-15', '2026-05-15'];
  return LINES.flatMap((line, l) =>
    purchases.map((date, i) =>
      txn({ id: `t-${l}-${i}`, date, type: 'BUY', symbol: line.symbol, quantity: 10, price: Math.round(price(line, date) * 100) / 100, currency: line.currency }),
    ),
  );
}

export function closes(): EodPrice[] {
  return LINES.filter((line) => line.stored !== 'none').flatMap((line) =>
    days(WINDOW_START, TODAY).map((date) =>
      line.stored === 'major'
        ? { symbol: line.symbol, date, close: price(line, date), currency: line.currency }
        : { symbol: line.symbol, date, close: price(line, date) / 100, currency: 'GBP' },
    ),
  );
}

export function quotes(): Record<string, Quote> {
  return Object.fromEntries(
    LINES.map((line) => [line.symbol, { symbol: line.symbol, price: price(line, TODAY), previousClose: price(line, '2026-06-14'), currency: line.currency, asOf: `${TODAY}T10:00:00.000Z`, source: 't212' }]),
  );
}

export function ownerScenario() {
  const ctx = fakeDeps();
  ctx.repo.portfolios = [portfolio({ portfolioId: 'default', name: 'Main' })];
  ctx.repo.transactions = transactions();
  ctx.repo.eod = closes();
  ctx.repo.quotes = quotes();
  ctx.repo.fx = { base: 'EUR', rates: { USD, GBP }, asOf: `${TODAY}T00:00:00Z` };
  // The fixings only reach back a few months: before them the earliest one stands in.
  ctx.repo.fxDays = days('2026-02-02', TODAY).map((date) => ({ base: 'EUR', date, rates: { USD, GBP } }));
  return { ...ctx, handler: createHandler(() => ctx.deps) };
}


