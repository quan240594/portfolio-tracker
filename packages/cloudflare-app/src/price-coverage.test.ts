import { MemoryItemStore } from '@portfolio/platform';
import { parsePricesConfig } from '@portfolio/prices';
import { MAX_COVERAGE_ROWS, MAX_COVERAGE_SYMBOLS, priceHistoryCoverageSchema, type Transaction } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { loadPriceCoverage } from './price-coverage.js';

const NOW = new Date('2026-10-23T09:00:00.000Z');
const USER = 'u1';
const KEYS = { TWELVEDATA_API_KEY: 'td', EODHD_API_KEY: 'eod' };

const buy = (symbol: string, date: string, over: Partial<Transaction> = {}): Transaction => ({
  id: `${symbol}-${date}-${over.type ?? 'BUY'}`,
  userId: USER,
  portfolioId: 'p1',
  date,
  type: 'BUY',
  symbol,
  quantity: 1,
  price: 10,
  fee: 0,
  currency: 'EUR',
  createdAt: `${date}T08:00:00Z`,
  ...over,
});
const txItem = (t: Transaction) => ({ PK: `USER#${t.userId}`, SK: `TXN#${t.portfolioId}#${t.date}#${t.id}`, entityType: 'TRANSACTION', ...t });
const eod = (symbol: string, date: string, extra: Record<string, unknown> = {}) => ({ PK: `TICKER#${symbol}`, SK: `EOD#${date}`, entityType: 'EOD', symbol, date, close: 10, currency: 'EUR', ...extra });
const quote = (symbol: string, extra: Record<string, unknown> = {}) => ({ PK: `TICKER#${symbol}`, SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol, price: 10, previousClose: 9, currency: 'EUR', asOf: '2026-10-23T08:00:00.000Z', source: 't212', ...extra });
const profile = (symbol: string, name: string) => ({ PK: `TICKER#${symbol}`, SK: 'PROFILE', entityType: 'PROFILE', symbol, name, assetClass: 'STOCK', currency: 'EUR' });

const days = (from: string, count: number): string[] => Array.from({ length: count }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

async function load(items: readonly Record<string, unknown>[], env: Record<string, string> = KEYS) {
  const store = new MemoryItemStore().load(items as never);
  return { store, report: await loadPriceCoverage({ items: store, config: parsePricesConfig(env), now: () => NOW }, USER) };
}

describe('loadPriceCoverage', () => {
  it('classifies complete, partial and missing symbols with the reason of each, the worst first', async () => {
    const { report } = await load([
      txItem(buy('ASML.AS', '2026-03-02')),
      txItem(buy('MSFT', '2026-03-02')),
      txItem(buy('AAPL', '2026-03-02')),
      txItem(buy('SOLD', '2026-03-02')),
      txItem(buy('SOLD', '2026-04-02', { type: 'SELL' })),
      txItem(buy('CASH.EUR', '2026-03-02')),
      ...[...days('2026-03-02', 3), '2026-10-22', '2026-10-23'].map((date) => eod('ASML.AS', date, { source: 'eodhd' })),
      ...['2026-09-01', '2026-10-23'].map((date) => eod('MSFT', date)),
      quote('ASML.AS'),
      profile('ASML.AS', 'ASML Holding'),
      { PK: 'TICKER#AAPL', SK: 'ENRICH#core', entityType: 'ENRICH_STATE', symbol: 'AAPL', day: '2026-10-22', attempts: 5, outcome: 'skipped', lastError: 'no data' },
      { PK: 'TICKER#MSFT', SK: 'ENRICH#core', entityType: 'ENRICH_STATE', symbol: 'MSFT', day: '2026-10-23', attempts: 2, outcome: 'retry', lastError: 'GET https://api.example.test/eod?apikey=SECRET failed with 500' },
    ]);
    expect(priceHistoryCoverageSchema.parse(report)).toEqual(report);
    expect(report.symbols.map((row) => [row.symbol, row.historyState])).toEqual([
      ['AAPL', 'missing'],
      ['MSFT', 'partial'],
      ['ASML.AS', 'complete'],
    ]);
    const [aapl, msft, asml] = report.symbols;
    expect(aapl).toMatchObject({ name: 'AAPL', provider: 'twelvedata', eodRows: 0, reason: 'Provider has no data for this symbol', lastAttempt: { day: '2026-10-22', attempts: 5, outcome: 'skipped', error: 'no data' } });
    expect(msft).toMatchObject({ eodRows: 2, firstEod: '2026-09-01', lastEod: '2026-10-23', eodSources: ['provider'], reason: 'Last attempt failed, retried automatically', lastAttempt: { outcome: 'retry', error: 'GET [url] failed with 500' } });
    expect(JSON.stringify(report)).not.toContain('SECRET');
    expect(asml).toMatchObject({ name: 'ASML Holding', provider: 'eodhd', eodRows: 5, eodSources: ['eodhd'], lastQuoteAt: '2026-10-23T08:00:00.000Z', lastQuoteSource: 't212', firstTransaction: '2026-03-02', reason: 'Full history stored' });
    expect(report.totals).toEqual({ held: 3, complete: 1, partial: 1, missing: 1, valuedAtCostSince: '2026-03-02', valuedAtCostUntil: '2026-10-23', truncated: false });
    expect(report.asOf).toBe(NOW.toISOString());
  });

  it('explains a missing history by the missing key, a blocked provider, or a fresh symbol, in that priority', async () => {
    const items = [txItem(buy('ASML.AS', '2026-03-02')), txItem(buy('AAPL', '2026-03-02')), txItem(buy('BTC-EUR', '2026-03-02'))];
    const unkeyed = await load(items, {});
    expect(Object.fromEntries(unkeyed.report.symbols.map((row) => [row.symbol, row.reason]))).toEqual({ 'ASML.AS': 'No provider key for this exchange', AAPL: 'No provider key for this exchange', 'BTC-EUR': 'No provider key for this exchange' });
    expect(unkeyed.report.symbols.map((row) => row.provider)).toEqual(['twelvedata', 'eodhd', 'coingecko']);

    const fresh = await load(items, { ...KEYS, COINGECKO_API_KEY: 'cg' });
    expect(fresh.report.symbols.every((row) => row.reason === 'Not tried yet')).toBe(true);

    const blocked = await load([...items, { PK: 'USAGE', SK: 'BLOCK#eodhd', until: NOW.getTime() + 3_600_000, scope: 'day' }], { ...KEYS, COINGECKO_API_KEY: 'cg' });
    expect(Object.fromEntries(blocked.report.symbols.map((row) => [row.symbol, row.reason]))).toEqual({ 'ASML.AS': 'Daily quota used up, retries after reset', AAPL: 'Not tried yet', 'BTC-EUR': 'Not tried yet' });
  });

  it('says only part is stored for a partial symbol nothing was tried for', async () => {
    const { report } = await load([txItem(buy('AAPL', '2026-03-02')), eod('AAPL', '2026-10-23', { source: 't212' })]);
    expect(report.symbols[0]).toMatchObject({ historyState: 'partial', reason: 'Only part of the history is stored', eodSources: ['t212'] });
  });

  it('reads the newest rows only, flags more, and counts every row it read', async () => {
    const many = days('2025-07-31', MAX_COVERAGE_ROWS + 50).map((date) => eod('AAPL', date));
    const { report } = await load([txItem(buy('AAPL', '2024-01-02')), ...many, quote('AAPL')]);
    const [row] = report.symbols;
    expect(row).toMatchObject({ eodRows: MAX_COVERAGE_ROWS, eodRowsCapped: true, firstEod: '2025-09-19', lastEod: '2026-10-23', historyState: 'complete' });
    expect(report.rowsRead).toBe(1 + (MAX_COVERAGE_ROWS + 1) + 1);
  });

  it('examines at most 60 symbols, in alphabetical order, and still counts them all as held', async () => {
    const symbols = Array.from({ length: MAX_COVERAGE_SYMBOLS + 5 }, (_, i) => `S${String(i).padStart(3, '0')}`);
    const { report } = await load(symbols.map((symbol) => txItem(buy(symbol, '2026-10-01'))));
    expect(report.symbols).toHaveLength(MAX_COVERAGE_SYMBOLS);
    expect(report.totals).toMatchObject({ held: MAX_COVERAGE_SYMBOLS + 5, missing: MAX_COVERAGE_SYMBOLS, truncated: true });
    expect(report.symbols.map((row) => row.symbol)).toEqual(symbols.slice(0, MAX_COVERAGE_SYMBOLS));
  });

  it('is empty for a user without open positions and ignores the transactions of other users', async () => {
    const other = { ...buy('AAPL', '2026-03-02'), userId: 'someone-else' };
    const { report } = await load([txItem(other), txItem(buy('GONE', '2026-03-02')), txItem(buy('GONE', '2026-03-03', { type: 'SELL' }))]);
    expect(report).toEqual({ asOf: NOW.toISOString(), symbols: [], totals: { held: 0, complete: 0, partial: 0, missing: 0, valuedAtCostSince: null, valuedAtCostUntil: null, truncated: false }, rowsRead: 2 });
  });
});
