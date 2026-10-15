import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { buildPositions, calculatePortfolio, cashBalances, type FxDay, type FxRates, type InstrumentProfile, type Quote, type Transaction } from '@portfolio/shared';
import { generateFxDays, isEcbBusinessDay, seed } from './seed.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-west-1' }));
const TODAY = '2026-10-13';

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(BatchWriteCommand).resolves({});
});

const written = () =>
  ddbMock
    .commandCalls(BatchWriteCommand)
    .flatMap((c) => c.args[0].input.RequestItems!.tbl!)
    .map((r) => r.PutRequest?.Item as Record<string, unknown>)
    .filter(Boolean);

describe('isEcbBusinessDay', () => {
  it('excludes weekends and TARGET holidays (incl. Good Friday / Easter Monday)', () => {
    expect(isEcbBusinessDay('2025-04-17')).toBe(true); // Thursday
    expect(isEcbBusinessDay('2025-04-18')).toBe(false); // Good Friday
    expect(isEcbBusinessDay('2025-04-21')).toBe(false); // Easter Monday
    expect(isEcbBusinessDay('2026-04-03')).toBe(false); // Good Friday 2026
    expect(isEcbBusinessDay('2026-04-06')).toBe(false); // Easter Monday 2026
    for (const d of ['2025-01-01', '2025-05-01', '2025-12-25', '2025-12-26']) expect(isEcbBusinessDay(d)).toBe(false);
    expect(isEcbBusinessDay('2025-10-11')).toBe(false); // Saturday
    expect(isEcbBusinessDay('2025-10-12')).toBe(false); // Sunday
  });
});

describe('generateFxDays', () => {
  const days = generateFxDays('2025-01-02', TODAY);

  it('produces EUR-based fixings on business days only', () => {
    expect(days.length).toBeGreaterThan(400);
    expect(days.every((d) => d.base === 'EUR' && isEcbBusinessDay(d.date))).toBe(true);
    expect(days.map((d) => d.date)).toEqual([...days.map((d) => d.date)].sort());
    expect(Object.keys(days[0]!.rates).sort()).toEqual(['CHF', 'GBP', 'USD']);
  });

  it('drifts USD from 1.04 to 1.17 with realistic, 4-decimal daily moves', () => {
    expect(days[0]!.rates.USD).toBe(1.04);
    expect(days.at(-1)!.rates.USD).toBe(1.17);
    expect(days.at(-1)!.rates.GBP).toBe(0.87);
    for (let i = 1; i < days.length; i++) {
      const usd = days[i]!.rates.USD!;
      expect(usd).toBe(Math.round(usd * 1e4) / 1e4);
      expect(Math.abs(Math.log(usd / days[i - 1]!.rates.USD!))).toBeLessThan(0.03);
      expect(usd).toBeGreaterThan(0.95);
      expect(usd).toBeLessThan(1.3);
    }
  });

  it('is deterministic', () => {
    expect(generateFxDays('2025-01-02', TODAY)).toEqual(days);
  });
});

describe('seed', () => {
  it('writes two portfolios and assigns USD trades to Trading 212, everything else to the main portfolio', async () => {
    const { portfolios, transactions } = await seed({ doc, tableName: 'tbl', today: TODAY, log: () => {} });
    expect(portfolios.map((p) => [p.portfolioId, p.name])).toEqual([
      ['default', 'Main portfolio'],
      ['trading-212', 'Trading 212'],
    ]);
    expect(portfolios[0]!.createdAt < portfolios[1]!.createdAt).toBe(true);
    const items = written().filter((i) => i.entityType === 'PORTFOLIO');
    expect(items).toEqual(portfolios.map((p) => ({ PK: 'USER#demo', SK: `PORTFOLIO#${p.portfolioId}`, entityType: 'PORTFOLIO', ...p })));

    const symbolsOf = (id: string) => [...new Set(transactions.filter((t) => t.portfolioId === id).map((t) => t.symbol))].sort();
    expect(symbolsOf('default')).toEqual(['ASML.AS', 'BTC-EUR', 'CASH.EUR', 'IWDA.AS', 'VWRL.AS']);
    expect(symbolsOf('trading-212')).toEqual(['AAPL', 'MSFT']);
    expect(transactions.filter((t) => t.fxRate !== undefined).every((t) => t.portfolioId === 'trading-212')).toBe(true);
    for (const t of written().filter((i) => i.entityType === 'TRANSACTION')) {
      expect(t.SK).toBe(`TXN#${String(t.portfolioId)}#${String(t.date)}#${String(t.id)}`);
    }
  });

  it('removes earlier seed transactions in both the current and the pre-portfolio key layout', async () => {
    ddbMock.on(QueryCommand).resolvesOnce({
      Items: [{ PK: 'USER#demo', SK: 'TXN#2025-01-02#seed-01' }],
      LastEvaluatedKey: { PK: 'USER#demo', SK: 'TXN#2025-01-02#seed-01' },
    }).resolvesOnce({ Items: [{ PK: 'USER#demo', SK: 'TXN#default#2025-01-03#seed-02' }] });
    const { removed } = await seed({ doc, tableName: 'tbl', today: TODAY, log: () => {} });
    expect(removed).toBe(2);
    const query = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(query.ExpressionAttributeValues).toEqual({ ':pk': 'USER#demo', ':sk': 'TXN#', ':seed': 'seed-' });
    const deletes = ddbMock
      .commandCalls(BatchWriteCommand)
      .flatMap((c) => c.args[0].input.RequestItems!.tbl!)
      .map((r) => r.DeleteRequest?.Key)
      .filter(Boolean);
    expect(deletes).toEqual([
      { PK: 'USER#demo', SK: 'TXN#2025-01-02#seed-01' },
      { PK: 'USER#demo', SK: 'TXN#default#2025-01-03#seed-02' },
    ]);
    // Deletes are sent before any put, so a stale key equal to a fresh one cannot remove the new item.
    const firstPut = ddbMock.commandCalls(BatchWriteCommand).findIndex((c) => c.args[0].input.RequestItems!.tbl![0]!.PutRequest);
    expect(firstPut).toBe(1);
  });

  it('writes daily FX_DAY items and a LATEST item matching the newest fixing', async () => {
    const { fxDays } = await seed({ doc, tableName: 'tbl', today: TODAY, log: () => {} });
    const items = written();
    const dayItems = items.filter((i) => i.entityType === 'FX_DAY');
    expect(dayItems).toHaveLength(fxDays.length);
    expect(dayItems[0]).toEqual({ PK: 'FX#EUR', SK: `DAY#${fxDays[0]!.date}`, entityType: 'FX_DAY', ...fxDays[0] });
    expect(dayItems.every((i) => isEcbBusinessDay(String(i.date)))).toBe(true);
    const latest = items.find((i) => i.PK === 'FX#EUR' && i.SK === 'LATEST')!;
    expect(latest).toMatchObject({ entityType: 'FX', base: 'EUR', rates: fxDays.at(-1)!.rates });
    expect(latest.rates).toMatchObject({ USD: 1.17 });

    // The fixings cover every transaction date with a prior fixing (incl. the API's 7-day lookback).
    const txns = items.filter((i) => i.entityType === 'TRANSACTION') as unknown as Transaction[];
    const first = txns.map((t) => t.date).sort()[0]!;
    expect(fxDays[0]!.date <= first).toBe(true);
  });

  it('gives some USD transactions a broker fxRate near the ECB fixing and leaves the rest on ECB', async () => {
    const { transactions, fxDays } = await seed({ doc, tableName: 'tbl', today: TODAY, log: () => {} });
    const fixing = (date: string) => fxDays.filter((d) => d.date <= date).at(-1)!.rates.USD!;
    const withBroker = transactions.filter((t) => t.fxRate !== undefined);
    expect(withBroker.map((t) => [t.id, t.type, t.symbol])).toEqual([
      ['seed-01', 'BUY', 'AAPL'],
      ['seed-08', 'DIVIDEND', 'AAPL'],
      ['seed-11', 'SELL', 'MSFT'],
    ]);
    for (const t of withBroker) {
      expect(t.currency).toBe('USD');
      expect(t.note).toBe('Demo seed (broker FX rate)');
      const spread = t.fxRate! / fixing(t.date) - 1;
      expect(Math.abs(Math.abs(spread) - 0.0025)).toBeLessThan(1e-4);
      expect(Math.sign(spread)).toBe(t.type === 'BUY' ? -1 : 1);
    }
    const ecbUsd = transactions.filter((t) => t.currency === 'USD' && t.fxRate === undefined);
    expect(ecbUsd.length).toBeGreaterThan(0);
    expect(transactions.filter((t) => t.currency === 'EUR').every((t) => t.fxRate === undefined)).toBe(true);
  });

  it('keeps full English country names on profiles', async () => {
    await seed({ doc, tableName: 'tbl', today: TODAY, log: () => {} });
    const countries = new Set(written().filter((i) => i.entityType === 'PROFILE').map((i) => i.country));
    expect([...countries].sort()).toEqual(['Germany', 'Global', 'Netherlands', 'United States']);
  });

  it('gives AAPL and MSFT a P/E (with its date) and leaves ASML without, so P/E coverage is partial', async () => {
    await seed({ doc, tableName: 'tbl', today: TODAY, log: () => {} });
    const profiles = Object.fromEntries(written().filter((i) => i.entityType === 'PROFILE').map((i) => [String(i.symbol), i]));
    expect(profiles.AAPL).toMatchObject({ peRatio: 33.4, fundamentalsAsOf: TODAY });
    expect(profiles.MSFT).toMatchObject({ peRatio: 34.9, fundamentalsAsOf: TODAY });
    expect(profiles['ASML.AS']).not.toHaveProperty('peRatio');
    expect(profiles['VWRL.AS']).not.toHaveProperty('fundamentalsAsOf');
  });

  it('yields a negative currency effect on USD holdings as EUR strengthens', async () => {
    await seed({ doc, tableName: 'tbl', today: TODAY, log: () => {} });
    const items = written();
    const of = <T>(type: string) => items.filter((i) => i.entityType === type) as unknown as T[];
    const quotes = Object.fromEntries(of<Quote>('QUOTE').map((q) => [q.symbol, q]));
    const profiles = Object.fromEntries(of<InstrumentProfile>('PROFILE').map((p) => [p.symbol, p]));
    const fx = items.find((i) => i.SK === 'LATEST') as unknown as FxRates;
    const { holdings, summary } = calculatePortfolio({
      transactions: of<Transaction>('TRANSACTION'),
      quotes,
      profiles,
      fx,
      fxHistory: of<FxDay>('FX_DAY'),
    });
    const aapl = holdings.find((h) => h.symbol === 'AAPL')!;
    expect(aapl.currencyEffect).toBeLessThan(0);
    expect(holdings.find((h) => h.symbol === 'VWRL.AS')!.currencyEffect).toBe(0);
    expect(summary.currencyEffect).toBeLessThan(0);
  });

  it('seeds cash, a split, categories with targets, custom assets, settings and a watchlist', async () => {
    const { transactions } = await seed({ doc, tableName: 'tbl', today: TODAY, log: () => {} });
    const items = written();
    const of = <T>(type: string) => items.filter((i) => i.entityType === type) as unknown as T[];

    expect(transactions.filter((t) => t.type === 'SPLIT')).toMatchObject([{ symbol: 'ASML.AS', quantity: 2, price: 0, fee: 0 }]);
    expect(transactions.filter((t) => t.symbol === 'CASH.EUR').map((t) => t.type)).toEqual(['DEPOSIT', 'DEPOSIT', 'WITHDRAWAL', 'INTEREST', 'FEE']);
    expect(transactions.every((t) => t.id.startsWith('seed-'))).toBe(true);

    expect(of('PORTFOLIO_SETTINGS')).toMatchObject([{ SK: 'PSETTINGS#default', trackCash: true, withholdingTaxRate: 15 }]);
    const categories = of<{ SK: string; targetWeight: number }>('CATEGORY');
    expect(categories.map((c) => c.SK)).toEqual(['CATEGORY#default#seed-cat-core', 'CATEGORY#default#seed-cat-stocks', 'CATEGORY#default#seed-cat-crypto', 'CATEGORY#default#seed-cat-other']);
    expect(categories.reduce((s, c) => s + c.targetWeight, 0)).toBe(95);
    expect(of<{ SK: string }>('CATEGORY_ASSIGNMENT').map((a) => a.SK)).toContain('CATASSIGN#default#CUSTOM:seed-asset-savings');
    expect(of<{ assetId: string }>('CUSTOM_ASSET').map((a) => a.assetId)).toEqual(['seed-asset-savings', 'seed-asset-startup']);
    expect(of<{ SK: string }>('WATCHLIST').map((w) => w.SK)).toEqual(['WATCH#NVDA', 'WATCH#SAP.DE', 'WATCH#ETH-EUR']);
    // Watchlist symbols have prices; custom and cash symbols are never registered as tracked tickers
    const tracked = of<{ symbol: string }>('TRACKED_TICKER').map((t) => t.symbol);
    expect(tracked).toEqual(expect.arrayContaining(['NVDA', 'SAP.DE', 'ETH-EUR']));
    expect(tracked.some((s) => s.startsWith('CASH.') || s.startsWith('CUSTOM:'))).toBe(false);
  });

  it('keeps the ASML position as before the split (6 shares) and the cash balance positive', async () => {
    await seed({ doc, tableName: 'tbl', today: TODAY, log: () => {} });
    const txns = written().filter((i) => i.entityType === 'TRANSACTION') as unknown as Transaction[];
    const asml = buildPositions(txns.filter((t) => t.portfolioId === 'default')).get('ASML.AS')!;
    expect(asml.quantity).toBe(6); // 2 pre-split shares x 2 + 2 bought later
    const cash = cashBalances(txns, new Set(['default']));
    expect(cash.get('EUR')!).toBeGreaterThan(0);
  });
});
