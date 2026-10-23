import { MemoryItemStore } from '@portfolio/platform';
import { describe, expect, it } from 'vitest';
import { HttpClient } from './http.js';
import { DailyQuota, MemoryQuotaLedger, TokenBucket } from './limits.js';
import { CoinGeckoProvider } from './providers/coingecko.js';
import { EodhdProvider } from './providers/eodhd.js';
import { TwelveDataProvider } from './providers/twelvedata.js';
import { AlphaVantageProvider } from './providers/alphavantage.js';
import { PriceRepository } from './repository.js';
import { FakeFetch } from './testing/fake-fetch.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const noSleep = (): Promise<void> => Promise.resolve();
const http = (fake: FakeFetch, name: string) => new HttpClient({ provider: name, fetch: fake.fetch, sleep: noSleep, maxRetries: 0, random: () => 0 });
const bucket = () => new TokenBucket(100, 100, () => 0, noSleep);
const quota = (name: string) => new DailyQuota(new MemoryQuotaLedger(), name, 100, () => '2026-10-13');
const twelve = (fake: FakeFetch) => new TwelveDataProvider({ apiKey: 'k', http: http(fake, 'twelvedata'), bucket: bucket(), quota: quota('twelvedata'), now: () => NOW });
const eodhd = (fake: FakeFetch) => new EodhdProvider({ apiKey: 'k', http: http(fake, 'eodhd'), bucket: bucket(), quota: quota('eodhd'), now: () => NOW });

const series = (currency: string) => ({ meta: { currency }, values: [{ datetime: '2026-10-09', close: '7250.5' }, { datetime: '2026-10-08', close: '7190' }] });

describe('EOD history is stored in major units (the provider rescales at the source)', () => {
  it.each([
    ['GBp', 'GBP', 72.505, 71.9],
    ['GBX', 'GBP', 72.505, 71.9],
    ['ZAc', 'ZAR', 72.505, 71.9],
    ['ILA', 'ILS', 72.505, 71.9],
    ['GBP', 'GBP', 7250.5, 7190],
    ['usd', 'USD', 7250.5, 7190],
  ])('Twelve Data, series labelled %s -> %s', async (label, currency, latest, previous) => {
    const rows = await twelve(new FakeFetch().add('/time_series', series(label))).getEodHistory('VOD.L', '2026-01-01', '2026-10-13');
    expect(rows).toEqual([
      { symbol: 'VOD.L', date: '2026-10-08', close: previous, currency },
      { symbol: 'VOD.L', date: '2026-10-09', close: latest, currency },
    ]);
  });

  it('Twelve Data labels a series without a currency as USD and leaves it alone', async () => {
    const rows = await twelve(new FakeFetch().add('/time_series', { values: [{ datetime: '2026-10-09', close: '101.5' }] })).getEodHistory('AAPL', '2026-01-01', '2026-10-13');
    expect(rows).toEqual([{ symbol: 'AAPL', date: '2026-10-09', close: 101.5, currency: 'USD' }]);
  });

  it('EODHD rescales the pence of a London symbol and keeps the euros of an Amsterdam one', async () => {
    const fake = new FakeFetch()
      .add('/eod/VOD.LSE', [{ date: '2026-10-09', close: 7250.5 }, { date: '2026-10-08', close: 7190 }])
      .add('/eod/ASML.AS', [{ date: '2026-10-09', close: 701.2 }]);
    const provider = eodhd(fake);
    expect(await provider.getEodHistory('VOD.L', '2026-01-01', '2026-10-13')).toEqual([
      { symbol: 'VOD.L', date: '2026-10-08', close: 71.9, currency: 'GBP' },
      { symbol: 'VOD.L', date: '2026-10-09', close: 72.505, currency: 'GBP' },
    ]);
    expect(await provider.getEodHistory('ASML.AS', '2026-01-01', '2026-10-13')).toEqual([{ symbol: 'ASML.AS', date: '2026-10-09', close: 701.2, currency: 'EUR' }]);
  });

  it('CoinGecko history is in the fiat currency it was asked for and stays as it is', async () => {
    const day = Date.UTC(2026, 9, 9);
    const fake = new FakeFetch().add('market_chart', { prices: [[day, 60000]] });
    const cg = new CoinGeckoProvider({ apiKey: 'k', http: http(fake, 'coingecko'), bucket: bucket(), now: () => NOW });
    expect(await cg.getEodHistory('BTC-EUR', '2026-10-01', '2026-10-13')).toEqual([{ symbol: 'BTC-EUR', date: '2026-10-09', close: 60000, currency: 'EUR' }]);
  });

  it('the profile currency is a plain ISO code even when the provider names a minor unit', async () => {
    const td = twelve(new FakeFetch().add('/profile', { name: 'Vodafone', type: 'Common Stock', currency: 'GBp' }));
    expect((await td.getProfile('VOD'))?.currency).toBe('GBP');
    const eod = eodhd(new FakeFetch().add('/search/VOD', [{ Code: 'VOD', Exchange: 'LSE', Name: 'Vodafone', Type: 'Common Stock', Currency: 'GBX' }]));
    expect((await eod.getProfile('VOD.L'))?.currency).toBe('GBP');
    const overview = { Symbol: 'VOD', Name: 'Vodafone', AssetType: 'Common Stock', Currency: 'GBX', Exchange: 'LSE' };
    const av = new AlphaVantageProvider({ apiKey: 'k', http: http(new FakeFetch().add('alphavantage', overview), 'alphavantage'), bucket: bucket(), quota: quota('alphavantage'), now: () => NOW });
    expect((await av.getProfile('VOD'))?.currency).toBe('GBP');
  });
});

describe('writes never store a minor unit, whatever produced the row', () => {
  const pence = { symbol: 'VOD.L', date: '2026-10-09', close: 7250, currency: 'GBX' };
  const get = (store: MemoryItemStore, sk: string) => store.get({ PK: 'TICKER#VOD.L', SK: sk });

  it('rescales EOD rows, quotes (and the EOD row of a quote) and dividends before they are put', async () => {
    const store = new MemoryItemStore();
    const repo = new PriceRepository(store);
    await repo.putEods([pence]);
    expect(await get(store, 'EOD#2026-10-09')).toMatchObject({ close: 72.5, currency: 'GBP' });

    const quote = { symbol: 'VOD.L', price: 7260, previousClose: 7250, currency: 'GBp', asOf: '2026-10-10T16:00:00.000Z', source: 'x' };
    await repo.putQuotes([quote]);
    expect(await get(store, 'QUOTE#LATEST')).toMatchObject({ price: 72.6, previousClose: 72.5, currency: 'GBP' });
    expect(await get(store, 'EOD#2026-10-10')).toMatchObject({ close: 72.6, currency: 'GBP' });

    await repo.putQuote({ ...quote, price: 7270 });
    expect(await get(store, 'QUOTE#LATEST')).toMatchObject({ price: 72.7, currency: 'GBP' });
    await repo.putDividends([{ symbol: 'VOD.L', exDate: '2026-08-01', amount: 4.5, currency: 'GBX' }]);
    expect(await get(store, 'DIV#2026-08-01')).toMatchObject({ amount: 0.045, currency: 'GBP' });
  });

  it('leaves rows in a major currency exactly as they are (never divides a GBP row)', async () => {
    const store = new MemoryItemStore();
    const repo = new PriceRepository(store);
    await repo.putEods([{ ...pence, close: 72.5, currency: 'GBP' }]);
    await repo.putQuotes([{ symbol: 'VOD.L', price: 72.6, previousClose: 72.5, currency: 'GBP', asOf: '2026-10-10T16:00:00.000Z', source: 'x' }]);
    expect(await get(store, 'EOD#2026-10-09')).toMatchObject({ close: 72.5, currency: 'GBP' });
    expect(await get(store, 'QUOTE#LATEST')).toMatchObject({ price: 72.6, currency: 'GBP' });
  });

  it('reads a quote stored in pence in major units (the age check and the merge see pounds)', async () => {
    const store = new MemoryItemStore().load([{ PK: 'TICKER#VOD.L', SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol: 'VOD.L', price: 7260, previousClose: 7250, currency: 'GBX', asOf: '2026-10-10T16:00:00.000Z', source: 'x' }]);
    expect((await new PriceRepository(store).latestQuotes(['VOD.L'])).get('VOD.L')).toMatchObject({ price: 72.6, previousClose: 72.5, currency: 'GBP' });
  });
});

describe('repairMinorUnits', () => {
  const eod = (symbol: string, date: string, close: number, currency: string) => ({ PK: `TICKER#${symbol}`, SK: `EOD#${date}`, entityType: 'EOD', symbol, date, close, currency });
  const quote = (symbol: string, price: number, currency: string) => ({ PK: `TICKER#${symbol}`, SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol, price, previousClose: price - 10, currency, asOf: '2026-10-10T16:00:00.000Z', source: 'x' });

  it('rewrites only the minor-unit rows (EOD and quote) of the symbol, in one batched write, and reports the rows', async () => {
    const store = new MemoryItemStore().load([
      eod('VOD.L', '2026-10-08', 7190, 'GBX'),
      eod('VOD.L', '2026-10-09', 7250, 'GBp'),
      eod('VOD.L', '2026-10-10', 72.6, 'GBP'),
      quote('VOD.L', 7260, 'GBX'),
      eod('JSE.JO', '2026-10-09', 25000, 'ZAc'),
      eod('TEVA.TA', '2026-10-09', 9000, 'ILA'),
      eod('AAPL', '2026-10-09', 230, 'USD'),
      { PK: 'TICKER#VOD.L', SK: 'PROFILE', entityType: 'PROFILE', symbol: 'VOD.L', name: 'Vodafone', assetClass: 'STOCK', currency: 'GBP' },
    ]);
    const repo = new PriceRepository(store);
    const batches: number[] = [];
    const batchWrite = store.batchWrite.bind(store);
    store.batchWrite = (operations) => {
      batches.push(operations.length);
      return batchWrite(operations);
    };
    expect(await repo.repairMinorUnits('VOD.L')).toEqual({ read: 4, written: 3 });
    expect(batches).toEqual([3]);
    expect(await store.get({ PK: 'TICKER#VOD.L', SK: 'EOD#2026-10-08' })).toEqual(eod('VOD.L', '2026-10-08', 71.9, 'GBP'));
    expect(await store.get({ PK: 'TICKER#VOD.L', SK: 'EOD#2026-10-09' })).toMatchObject({ close: 72.5, currency: 'GBP' });
    expect(await store.get({ PK: 'TICKER#VOD.L', SK: 'EOD#2026-10-10' })).toEqual(eod('VOD.L', '2026-10-10', 72.6, 'GBP'));
    expect(await store.get({ PK: 'TICKER#VOD.L', SK: 'QUOTE#LATEST' })).toMatchObject({ price: 72.6, previousClose: 72.5, currency: 'GBP' });
    expect(await store.get({ PK: 'TICKER#JSE.JO', SK: 'EOD#2026-10-09' })).toMatchObject({ close: 25000, currency: 'ZAc' });

    expect(await repo.repairMinorUnits('JSE.JO')).toEqual({ read: 1, written: 1 });
    expect(await store.get({ PK: 'TICKER#JSE.JO', SK: 'EOD#2026-10-09' })).toMatchObject({ close: 250, currency: 'ZAR' });
    expect(await repo.repairMinorUnits('TEVA.TA')).toEqual({ read: 1, written: 1 });
    expect(await store.get({ PK: 'TICKER#TEVA.TA', SK: 'EOD#2026-10-09' })).toMatchObject({ close: 90, currency: 'ILS' });
  });

  it('is idempotent: a second pass reads the same rows and writes nothing', async () => {
    const store = new MemoryItemStore().load([eod('VOD.L', '2026-10-09', 7250, 'GBX'), quote('VOD.L', 7260, 'GBX')]);
    const repo = new PriceRepository(store);
    expect(await repo.repairMinorUnits('VOD.L')).toEqual({ read: 2, written: 2 });
    const after = store.snapshot();
    let writes = 0;
    store.batchWrite = () => {
      writes += 1;
      return Promise.resolve();
    };
    expect(await repo.repairMinorUnits('VOD.L')).toEqual({ read: 2, written: 0 });
    expect(writes).toBe(0);
    expect(store.snapshot()).toEqual(after);
  });

  it('copes with a symbol that has no rows and with rows that carry no numbers', async () => {
    const store = new MemoryItemStore().load([{ PK: 'TICKER#ODD', SK: 'EOD#2026-10-09', entityType: 'EOD', symbol: 'ODD', currency: 'GBX' }]);
    const repo = new PriceRepository(store);
    expect(await repo.repairMinorUnits('NONE')).toEqual({ read: 0, written: 0 });
    expect(await repo.repairMinorUnits('ODD')).toEqual({ read: 1, written: 1 });
    expect(await store.get({ PK: 'TICKER#ODD', SK: 'EOD#2026-10-09' })).toMatchObject({ currency: 'GBP' });
  });

  it('keeps the marker apart from the other USAGE items', async () => {
    const store = new MemoryItemStore();
    const repo = new PriceRepository(store);
    expect(await repo.minorUnitRepairDone()).toBe(false);
    await repo.markMinorUnitRepair('2026-10-13T12:00:00.000Z', { read: 5, written: 2 });
    expect(await repo.minorUnitRepairDone()).toBe(true);
    expect(await store.get({ PK: 'USAGE', SK: 'REPAIR#minor-units-v1' })).toMatchObject({ doneAt: '2026-10-13T12:00:00.000Z', read: 5, written: 2 });
  });
});
