/**
 * CPU of parsing the external payloads the background jobs handle (synthetic but shape-faithful):
 *  - Trading 212 history pages (50 items: orders / dividends / cash movements), validated with the REAL zod schemas
 *    of services/broker-sync, in the same one-item-at-a-time way;
 *  - Twelve Data 5-year daily time series (1,300 bars) and an EODHD dividend list;
 *  - the Alpha Vantage EARNINGS_CALENDAR CSV (~4,600 rows) filtered to the tracked symbols.
 *   node --expose-gc --import tsx src/bench/payload-cpu.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cashTransactionSchema, dividendSchema, historicalOrderSchema, pageSchema } from '../../../../../services/broker-sync/src/t212/schemas.js';

const cpu = (fn: () => unknown, runs = 40) => {
  for (let i = 0; i < 8; i++) fn();
  (globalThis as { gc?: () => void }).gc?.();
  const s: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = process.cpuUsage();
    fn();
    const d = process.cpuUsage(t);
    s.push((d.user + d.system) / 1000);
  }
  s.sort((a, b) => a - b);
  return { medianMs: Number(s[Math.floor(s.length / 2)]!.toFixed(3)), p95Ms: Number(s[Math.ceil(0.95 * s.length) - 1]!.toFixed(3)) };
};

const orderItem = (i: number) => ({
  order: { id: 900000 + i, side: i % 5 === 0 ? 'SELL' : 'BUY', status: 'FILLED', ticker: 'AAPL_US_EQ', type: 'MARKET', strategy: 'QUANTITY', createdAt: '2025-03-04T10:15:00.000Z', currency: 'USD', extendedHours: false, initiatedFrom: 'API', instrument: { ticker: 'AAPL_US_EQ', name: 'Apple', isin: 'US0378331005', currency: 'USD' } },
  fill: { id: 700000 + i, quantity: 1.25, price: 187.12, type: 'TRADE', tradingMethod: 'TOTV', filledAt: '2025-03-04T10:15:03.000Z', walletImpact: { currency: 'EUR', netValue: 218.5, realisedProfitLoss: 0, fxRate: 1.0693, taxes: [{ name: 'CURRENCY_CONVERSION_FEE', quantity: 0.33, currency: 'EUR', chargedAt: '2025-03-04T10:15:03.000Z' }] } },
});
const dividendItem = (i: number) => ({ reference: `ref-${i}`, ticker: 'KO_US_EQ', instrument: { ticker: 'KO_US_EQ', name: 'Coca-Cola', isin: 'US1912161007', currency: 'USD' }, quantity: 12.5, amount: 4.1, grossAmountPerShare: 0.39, currency: 'EUR', tickerCurrency: 'USD', paidOn: '2025-03-14T00:00:00.000Z', type: 'ORDINARY' });
const cashItem = (i: number) => ({ reference: `c-${i}`, type: 'DEPOSIT', amount: 500, currency: 'EUR', dateTime: '2025-03-01T08:00:00.000Z' });
const page = (mk: (i: number) => object) => JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => mk(i)), nextPagePath: '/api/v0/equity/history/orders?cursor=123&limit=50' });

const parsePage = (text: string, schema: { safeParse: (x: unknown) => { success: boolean } }) => {
  const p = pageSchema.parse(JSON.parse(text));
  let ok = 0;
  for (const item of p.items) if (schema.safeParse(item).success) ok++;
  return ok;
};

const orders = page(orderItem);
const dividends = page(dividendItem);
const cash = page(cashItem);

const tdSeries = JSON.stringify({ meta: { symbol: 'AAPL', interval: '1day', currency: 'USD', exchange: 'NASDAQ' }, values: Array.from({ length: 1300 }, (_, i) => ({ datetime: `2021-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, open: '185.12000', high: '187.2', low: '184.9', close: '186.45000', volume: '51234000' })), status: 'ok' });
const eodhdDiv = JSON.stringify(Array.from({ length: 24 }, (_, i) => ({ date: `2024-0${(i % 9) + 1}-10`, declarationDate: null, recordDate: '2024-01-12', paymentDate: '2024-01-25', period: null, value: 0.25, unadjustedValue: 0.25, currency: 'USD' })));
const tracked = new Set(['AAPL', 'MSFT', 'NVDA', 'KO', 'JNJ', 'PG', 'V', 'O', 'SCHD', 'JEPI', 'TSLA', 'META', 'ADBE', 'GOOGL', 'AMZN']);
const csv = ['symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay', ...Array.from({ length: 4600 }, (_, i) => `${i % 40 === 0 ? [...tracked][(i / 40) % tracked.size | 0] : `ZZ${i}`},Some Company ${i} Inc,2026-11-${String((i % 28) + 1).padStart(2, '0')},2026-09-30,1.${i % 100},USD,pre-market`)].join('\n');
const filterCsv = (text: string) => {
  const out: string[] = [];
  let start = text.indexOf('\n') + 1;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    const line = text.slice(start, end < 0 ? text.length : end);
    const comma = line.indexOf(',');
    if (tracked.has(line.slice(0, comma))) out.push(line);
    if (end < 0) break;
    start = end + 1;
  }
  return out.length;
};

const out = {
  node: process.version,
  note: 'zod + JSON.parse only (the mapper adds the same order of magnitude); synthetic items are smaller than real T212 items, so treat as a lower bound',
  ['t212 orders page (50 items, ' + (orders.length / 1024).toFixed(0) + ' KB)']: cpu(() => parsePage(orders, historicalOrderSchema)),
  't212 dividends page (50 items)': cpu(() => parsePage(dividends, dividendSchema)),
  't212 cash page (50 items)': cpu(() => parsePage(cash, cashTransactionSchema)),
  ['twelvedata 5y daily series (1,300 bars, ' + (tdSeries.length / 1024).toFixed(0) + ' KB) JSON.parse + pack']: cpu(() => {
    const j = JSON.parse(tdSeries) as { values: { datetime: string; close: string }[] };
    return j.values.map((v) => [v.datetime, Number(v.close)]);
  }),
  'eodhd dividends (24 events)': cpu(() => JSON.parse(eodhdDiv)),
  ['alphavantage earnings csv (4,600 rows, ' + (csv.length / 1024).toFixed(0) + ' KB) filter to tracked']: cpu(() => filterCsv(csv)),
  'filtered rows found': filterCsv(csv),
};
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `payload-cpu-node${process.versions.node.split('.')[0]}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
