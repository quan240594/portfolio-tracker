import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { calculatePortfolio, type FxDay, type FxRates, type InstrumentProfile, type Quote, type Transaction } from '@portfolio/shared';
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
    expect([...countries].sort()).toEqual(['Global', 'Netherlands', 'United States']);
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
});
