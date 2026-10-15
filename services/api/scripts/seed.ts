/**
 * Idempotently seeds the local DynamoDB table (LocalStack) with two demo portfolios.
 *   pnpm --filter @portfolio/api seed
 * Prerequisite: `docker compose up -d` (the LocalStack init hook creates the table).
 */
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_PORTFOLIO_ID,
  DEFAULT_PORTFOLIO_NAME,
  ENTITY,
  MANAGEMENT_ENTITY,
  cashSymbol,
  keys,
  managementKeys,
  type AssetClass,
  type Category,
  type CategoryAssignment,
  type CustomAsset,
  type PortfolioSettings,
  type WatchlistEntry,
  type DividendEvent,
  type EodPrice,
  type FxDay,
  type FxRates,
  type InstrumentProfile,
  type Portfolio,
  type Quote,
  type Transaction,
  type TransactionType,
} from '@portfolio/shared';
import { calendarSeedItems } from './calendar-seed.js';

const LOCAL_ENV: Record<string, string> = {
  TABLE_NAME: 'portfolio-tracker-local',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_REGION: 'eu-west-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
};

interface InstrumentSeed {
  profile: InstrumentProfile;
  /** Price level on EPOCH, annual log drift, OU noise sigma (daily) and mean reversion. */
  p0: number;
  drift: number;
  sigma: number;
  crypto?: boolean;
}

const INSTRUMENTS: InstrumentSeed[] = [
  { profile: { symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'STOCK', sector: 'Technology', country: 'United States', exchange: 'NASDAQ', currency: 'USD', peRatio: 33.4 }, p0: 185, drift: 0.08, sigma: 0.014 },
  { profile: { symbol: 'MSFT', name: 'Microsoft Corp.', assetClass: 'STOCK', sector: 'Technology', country: 'United States', exchange: 'NASDAQ', currency: 'USD', peRatio: 34.9 }, p0: 375, drift: 0.1, sigma: 0.013 },
  { profile: { symbol: 'ASML.AS', name: 'ASML Holding N.V.', assetClass: 'STOCK', sector: 'Technology', country: 'Netherlands', exchange: 'Euronext Amsterdam', currency: 'EUR' }, p0: 680, drift: 0.06, sigma: 0.02 },
  { profile: { symbol: 'VWRL.AS', name: 'Vanguard FTSE All-World UCITS ETF', assetClass: 'ETF', sector: 'Diversified', country: 'Global', exchange: 'Euronext Amsterdam', currency: 'EUR' }, p0: 105, drift: 0.09, sigma: 0.008 },
  { profile: { symbol: 'IWDA.AS', name: 'iShares Core MSCI World UCITS ETF', assetClass: 'ETF', sector: 'Diversified', country: 'Global', exchange: 'Euronext Amsterdam', currency: 'EUR' }, p0: 82, drift: 0.09, sigma: 0.008 },
  { profile: { symbol: 'BTC-EUR', name: 'Bitcoin', assetClass: 'CRYPTO' as AssetClass, sector: 'Crypto', country: 'Global', exchange: 'CCC', currency: 'EUR' }, p0: 40000, drift: 0.25, sigma: 0.03, crypto: true },
  // Watchlist-only symbols (no transactions): they get quotes and history like any tracked ticker.
  { profile: { symbol: 'NVDA', name: 'NVIDIA Corp.', assetClass: 'STOCK', sector: 'Technology', country: 'United States', exchange: 'NASDAQ', currency: 'USD' }, p0: 480, drift: 0.2, sigma: 0.02 },
  { profile: { symbol: 'SAP.DE', name: 'SAP SE', assetClass: 'STOCK', sector: 'Technology', country: 'Germany', exchange: 'XETRA', currency: 'EUR' }, p0: 150, drift: 0.1, sigma: 0.015 },
  { profile: { symbol: 'ETH-EUR', name: 'Ethereum', assetClass: 'CRYPTO' as AssetClass, sector: 'Crypto', country: 'Global', exchange: 'CCC', currency: 'EUR' }, p0: 2300, drift: 0.2, sigma: 0.035, crypto: true },
];

/** Symbols on the demo user's watchlist (days ago they were added). */
export const SEED_WATCHLIST: [string, number][] = [
  ['NVDA', 30],
  ['SAP.DE', 20],
  ['ETH-EUR', 10],
];

export const TRADING_212_PORTFOLIO_ID = 'trading-212';
/** Seed portfolios in display order: EUR ETFs/stocks + crypto in the default one, US stocks at the broker. */
export const SEED_PORTFOLIOS = [
  { portfolioId: DEFAULT_PORTFOLIO_ID, name: DEFAULT_PORTFOLIO_NAME },
  { portfolioId: TRADING_212_PORTFOLIO_ID, name: 'Trading 212' },
] as const;
/** USD instruments are held at the broker (incl. the broker-fxRate trades); everything in EUR in the main portfolio. */
const seedPortfolioFor = (currency: string) => (currency === 'USD' ? TRADING_212_PORTFOLIO_ID : DEFAULT_PORTFOLIO_ID);

/** [daysAgo, type, symbol, quantity, fee, dividend per unit] */
const TXNS: [number, TransactionType, string, number, number, number?][] = [
  [540, 'BUY', 'AAPL', 10, 1],
  [520, 'BUY', 'VWRL.AS', 40, 2],
  [500, 'BUY', 'MSFT', 5, 1],
  [470, 'BUY', 'ASML.AS', 2, 2],
  [440, 'BUY', 'IWDA.AS', 50, 2],
  [400, 'BUY', 'BTC-EUR', 0.05, 5],
  [360, 'BUY', 'VWRL.AS', 20, 2],
  [330, 'DIVIDEND', 'AAPL', 10, 0.38, 0.25],
  [300, 'BUY', 'AAPL', 5, 1],
  [260, 'BUY', 'IWDA.AS', 30, 2],
  [220, 'SELL', 'MSFT', 2, 1],
  [180, 'DIVIDEND', 'VWRL.AS', 60, 0, 0.42],
  [150, 'BUY', 'ASML.AS', 2, 2],
  [90, 'BUY', 'BTC-EUR', 0.03, 3],
  [45, 'BUY', 'VWRL.AS', 15, 2],
  // Appended (ids seed-16..): a 2:1 split of ASML, whose first purchase (seed-04) was recorded for 2 pre-split shares
  // at the unadjusted price (2x the split-adjusted EOD close), so the position and cost basis are unchanged.
  [465, 'SPLIT', 'ASML.AS', 2, 0],
];

/** Seed transaction ids recorded at a pre-split price: factor between the unadjusted trade price and the adjusted EOD close. */
const PRE_SPLIT_PRICE_FACTOR: Record<string, number> = { 'seed-04': 2 };

/** Cash movements of the main portfolio (cash tracking is on there): [daysAgo, type, amount in EUR]. */
export const SEED_CASH_TXNS: [number, 'DEPOSIT' | 'WITHDRAWAL' | 'INTEREST' | 'FEE', number][] = [
  [545, 'DEPOSIT', 20000],
  [300, 'DEPOSIT', 10000],
  [60, 'WITHDRAWAL', 500],
  [30, 'INTEREST', 12.4],
  [20, 'FEE', 4.5],
];

const SEED_CATEGORIES: { id: string; name: string; color: string; targetWeight: number; symbols: string[] }[] = [
  { id: 'seed-cat-core', name: 'Core ETFs', color: '#2563eb', targetWeight: 55, symbols: ['VWRL.AS', 'IWDA.AS'] },
  { id: 'seed-cat-stocks', name: 'Single stocks', color: '#16a34a', targetWeight: 15, symbols: ['ASML.AS'] },
  { id: 'seed-cat-crypto', name: 'Crypto', color: '#f59e0b', targetWeight: 10, symbols: ['BTC-EUR'] },
  { id: 'seed-cat-other', name: 'Savings & private', color: '#9333ea', targetWeight: 15, symbols: [] },
];

/** [symbol, exDate offset (days from today), payDate offset, amount] */
const DIV_EVENTS: [string, number, number, number][] = [
  ['AAPL', 20, 27, 0.26],
  ['MSFT', 35, 70, 0.83],
  ['ASML.AS', 40, 47, 1.6],
  ['VWRL.AS', 60, 75, 0.45],
];

/** Seed ids whose trade carries an explicit broker-applied `fxRate` (the others use the ECB fixing). */
const BROKER_FX_TXNS = new Set(['seed-01', 'seed-08', 'seed-11']);
/** Broker FX margin vs. the ECB fixing; always to the customer's disadvantage. */
const BROKER_FX_SPREAD = 0.0025;

interface FxSeed {
  currency: string;
  /** Units of `currency` per 1 EUR at the start / end of the seeded period. */
  from: number;
  to: number;
  /** Daily OU noise sigma (log space). */
  sigma: number;
}

/** EUR strengthens over the seeded period (USD 1.04 -> 1.17), so USD holdings show a negative currency effect. */
const FX_SEEDS: FxSeed[] = [
  { currency: 'USD', from: 1.04, to: 1.17, sigma: 0.003 },
  { currency: 'GBP', from: 0.83, to: 0.87, sigma: 0.002 },
  { currency: 'CHF', from: 0.96, to: 0.93, sigma: 0.002 },
];
const EPOCH = '2024-01-01';
const MIN_EOD_DAYS = 400;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const isWeekend = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
const toWeekday = (date: string) => {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 6) return addDays(date, -1);
  if (dow === 0) return addDays(date, -2);
  return date;
};
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Easter Sunday (anonymous Gregorian algorithm). */
function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** ECB (TARGET2) publishes fixings on weekdays except New Year, Good Friday, Easter Monday, 1 May and 25/26 Dec. */
export function isEcbBusinessDay(date: string): boolean {
  if (isWeekend(date)) return false;
  const md = date.slice(5);
  if (['01-01', '05-01', '12-25', '12-26'].includes(md)) return false;
  const e = easter(Number(date.slice(0, 4)));
  return date !== addDays(e, -2) && date !== addDays(e, 1);
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0, 2166136261);

/**
 * Deterministic per calendar date (independent of the day the seed runs): the walk always starts
 * at EPOCH, so re-running the seed later only appends new days and never rewrites history.
 */
export function generateCloses(inst: InstrumentSeed, from: string, to: string): Map<string, number> {
  const rand = mulberry32(hash(inst.profile.symbol));
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  const closes = new Map<string, number>();
  let x = 0;
  const start = from < EPOCH ? from : EPOCH;
  for (let date = start, t = daysBetween(EPOCH, start); date <= to; date = addDays(date, 1), t++) {
    x = x * 0.985 + inst.sigma * gauss();
    if (date < from || (!inst.crypto && isWeekend(date))) continue;
    const trend = Math.log(inst.p0) + (inst.drift * t) / 365;
    closes.set(date, round(Math.exp(trend + x), 2));
  }
  return closes;
}

/**
 * Deterministic daily ECB fixings (business days only) for every FX_SEEDS currency between `from`
 * and `to`: a log-linear trend pinned to `seed.from` / `seed.to` at the period ends plus a
 * mean-reverting noise bridge (zero at both ends), so the latest fixing is exactly `seed.to`.
 */
export function generateFxDays(from: string, to: string): FxDay[] {
  const total = Math.max(1, daysBetween(from, to));
  const paths = FX_SEEDS.map((fx) => {
    const rand = mulberry32(hash(`FX#${fx.currency}`));
    const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
    const noise: number[] = [];
    let x = 0;
    for (let t = 0; t <= total; t++) {
      x = x * 0.985 + fx.sigma * gauss();
      noise.push(x);
    }
    return { fx, noise };
  });
  const days: FxDay[] = [];
  for (let date = from, t = 0; date <= to; date = addDays(date, 1), t++) {
    if (!isEcbBusinessDay(date)) continue;
    const frac = t / total;
    const rates = Object.fromEntries(
      paths.map(({ fx, noise }) => {
        const bridge = noise[t]! - noise[0]! - (noise[total]! - noise[0]!) * frac;
        const trend = Math.log(fx.from) + frac * Math.log(fx.to / fx.from);
        return [fx.currency, round(Math.exp(trend + bridge), 4)];
      }),
    );
    days.push({ base: 'EUR', date, rates });
  }
  return days;
}

export interface SeedOptions {
  doc: DynamoDBDocumentClient;
  tableName: string;
  userId?: string;
  today?: string;
  log?: (msg: string) => void;
}

function cashTransactions(userId: string, today: string): Transaction[] {
  return SEED_CASH_TXNS.map(([daysAgo, type, amount], i) => {
    const date = toWeekday(addDays(today, -daysAgo));
    return {
      id: `seed-cash-${String(i + 1).padStart(2, '0')}`,
      userId,
      portfolioId: DEFAULT_PORTFOLIO_ID,
      date,
      type,
      symbol: cashSymbol('EUR'),
      quantity: amount,
      price: 1,
      fee: 0,
      currency: 'EUR',
      note: 'Demo seed',
      createdAt: `${date}T08:00:00.000Z`,
    };
  });
}

/** Cash tracking, withholding tax, categories with targets, custom assets and the watchlist (all idempotent puts). */
function managementItems(userId: string, today: string, closeOn: (symbol: string, date: string) => number): Record<string, unknown>[] {
  const now = new Date().toISOString();
  const items: Record<string, unknown>[] = [];
  const put = (key: { PK: string; SK: string }, entityType: string, item: object) => items.push({ ...key, entityType, ...item });

  const settings: PortfolioSettings = { portfolioId: DEFAULT_PORTFOLIO_ID, userId, trackCash: true, withholdingTaxRate: 15, updatedAt: now };
  put(managementKeys.settings(userId, DEFAULT_PORTFOLIO_ID), MANAGEMENT_ENTITY.settings, settings);

  const ts = `${addDays(today, -540)}T00:00:00.000Z`;
  SEED_CATEGORIES.forEach((c, i) => {
    const category: Category = {
      categoryId: c.id,
      userId,
      portfolioId: DEFAULT_PORTFOLIO_ID,
      name: c.name,
      color: c.color,
      targetWeight: c.targetWeight,
      createdAt: `${ts.slice(0, 19)}.00${i}Z`,
      updatedAt: ts,
    };
    put(managementKeys.category(userId, DEFAULT_PORTFOLIO_ID, c.id), MANAGEMENT_ENTITY.category, category);
    for (const symbol of c.symbols) {
      const assignment: CategoryAssignment = { userId, portfolioId: DEFAULT_PORTFOLIO_ID, symbol, categoryId: c.id };
      put(managementKeys.assignment(userId, DEFAULT_PORTFOLIO_ID, symbol), MANAGEMENT_ENTITY.categoryAssignment, assignment);
    }
  });

  const assets: CustomAsset[] = [
    {
      assetId: 'seed-asset-savings',
      userId,
      portfolioId: DEFAULT_PORTFOLIO_ID,
      name: 'Savings account',
      assetClass: 'DEPOSIT',
      currency: 'EUR',
      costBasis: 5000,
      growthRate: 2.5,
      valuations: [{ date: addDays(today, -400), value: 5000 }],
      createdAt: ts,
      updatedAt: ts,
    },
    {
      assetId: 'seed-asset-startup',
      userId,
      portfolioId: DEFAULT_PORTFOLIO_ID,
      name: 'Private equity stake',
      assetClass: 'OTHER',
      currency: 'EUR',
      costBasis: 2500,
      valuations: [
        { date: addDays(today, -300), value: 2500 },
        { date: addDays(today, -120), value: 2900 },
      ],
      createdAt: ts,
      updatedAt: ts,
    },
  ];
  for (const a of assets) put(managementKeys.customAsset(userId, a.portfolioId, a.assetId), MANAGEMENT_ENTITY.customAsset, a);
  for (const a of assets) {
    const assignment: CategoryAssignment = { userId, portfolioId: DEFAULT_PORTFOLIO_ID, symbol: `CUSTOM:${a.assetId}`, categoryId: 'seed-cat-other' };
    put(managementKeys.assignment(userId, DEFAULT_PORTFOLIO_ID, assignment.symbol), MANAGEMENT_ENTITY.categoryAssignment, assignment);
  }

  for (const [symbol, daysAgo] of SEED_WATCHLIST) {
    closeOn(symbol, today); // fails loudly when the watchlist symbol has no seeded prices
    const entry: WatchlistEntry = { userId, symbol, addedAt: `${addDays(today, -daysAgo)}T10:00:00.000Z` };
    put(managementKeys.watchlist(userId, symbol), MANAGEMENT_ENTITY.watchlist, entry);
  }
  return items;
}

const seedPrice = (type: TransactionType, dividend: number | undefined, close: () => number): number => {
  if (type === 'SPLIT') return 0;
  return type === 'DIVIDEND' ? dividend! : round(close(), 4);
};

export async function seed({ doc, tableName, userId = 'demo', today = iso(new Date()), log = console.log }: SeedOptions) {
  const firstTxnDate = addDays(today, -Math.max(...TXNS.map((t) => t[0])));
  const eodFrom = addDays(today, -Math.max(MIN_EOD_DAYS, daysBetween(firstTxnDate, today) + 10));
  const now = new Date().toISOString();
  const items: Record<string, unknown>[] = [];

  const fxDays = generateFxDays(eodFrom, today);
  const fxOn = (currency: string, date: string) => {
    for (let i = fxDays.length - 1; i >= 0; i--) if (fxDays[i]!.date <= date) return fxDays[i]!.rates[currency]!;
    throw new Error(`No FX fixing for ${currency} on/before ${date}`);
  };

  const closes = new Map(INSTRUMENTS.map((i) => [i.profile.symbol, generateCloses(i, eodFrom, today)]));
  const closeOn = (symbol: string, date: string) => {
    const series = closes.get(symbol)!;
    for (let d = date; d >= eodFrom; d = addDays(d, -1)) if (series.has(d)) return series.get(d)!;
    throw new Error(`No close for ${symbol} on/before ${date}`);
  };

  for (const inst of INSTRUMENTS) {
    const { symbol, currency } = inst.profile;
    items.push(
      { ...keys.profile(symbol), entityType: ENTITY.profile, ...inst.profile, ...(inst.profile.peRatio === undefined ? {} : { fundamentalsAsOf: today }) },
      { ...keys.trackedTicker(symbol), entityType: ENTITY.trackedTicker, symbol, currency, createdAt: now, updatedAt: now },
    );
    const series = [...closes.get(symbol)!.entries()];
    for (const [date, close] of series) {
      const eod: EodPrice = { symbol, date, close, currency };
      items.push({ ...keys.eod(symbol, date), entityType: ENTITY.eod, ...eod });
    }
    const [prev, last] = series.slice(-2);
    const quote: Quote = { symbol, price: last![1], previousClose: prev![1], currency, asOf: `${last![0]}T17:30:00.000Z`, source: 'seed' };
    items.push({ ...keys.quote(symbol), entityType: ENTITY.quote, ...quote });
  }

  const transactions: Transaction[] = TXNS.map(([daysAgo, type, symbol, quantity, fee, dividend], i) => {
    const inst = INSTRUMENTS.find((x) => x.profile.symbol === symbol)!;
    const raw = addDays(today, -daysAgo);
    const date = inst.crypto ? raw : toWeekday(raw);
    const id = `seed-${String(i + 1).padStart(2, '0')}`;
    const currency = inst.profile.currency;
    const brokerFx = BROKER_FX_TXNS.has(id) && currency !== 'EUR';
    const t: Transaction = {
      id,
      userId,
      portfolioId: seedPortfolioFor(currency),
      date,
      type,
      symbol,
      quantity,
      price: seedPrice(type, dividend, () => closeOn(symbol, date) * (PRE_SPLIT_PRICE_FACTOR[id] ?? 1)),
      fee,
      currency,
      note: brokerFx ? 'Demo seed (broker FX rate)' : 'Demo seed',
      createdAt: `${date}T12:00:00.000Z`,
    };
    // Buying USD with EUR yields fewer USD per EUR than the fixing; converting USD back costs more USD per EUR.
    if (brokerFx) t.fxRate = round(fxOn(currency, date) * (type === 'BUY' ? 1 - BROKER_FX_SPREAD : 1 + BROKER_FX_SPREAD), 4);
    return t;
  });
  transactions.push(...cashTransactions(userId, today));
  for (const t of transactions) items.push({ ...keys.transaction(userId, t.portfolioId, t.date, t.id), entityType: ENTITY.transaction, ...t });

  // Fixed, ordered createdAt so the default portfolio is listed first and re-seeding does not reorder them.
  const portfolios: Portfolio[] = SEED_PORTFOLIOS.map(({ portfolioId, name }, i) => {
    const ts = `${addDays(firstTxnDate, -1)}T00:00:0${i}.000Z`;
    return { portfolioId, userId, name, createdAt: ts, updatedAt: ts };
  });
  for (const p of portfolios) items.push({ ...keys.portfolio(userId, p.portfolioId), entityType: ENTITY.portfolio, ...p });

  items.push(...managementItems(userId, today, closeOn));

  for (const [symbol, exOff, payOff, amount] of DIV_EVENTS) {
    const inst = INSTRUMENTS.find((x) => x.profile.symbol === symbol)!;
    const ev: DividendEvent = { symbol, exDate: addDays(today, exOff), payDate: addDays(today, payOff), amount, currency: inst.profile.currency };
    items.push({ ...keys.dividendEvent(symbol, ev.exDate), entityType: ENTITY.dividendEvent, ...ev });
  }

  items.push(...calendarSeedItems(today, now));

  for (const day of fxDays) items.push({ ...keys.fxDay(day.base, day.date), entityType: ENTITY.fxDay, ...day });
  // LATEST mirrors the newest daily fixing so market values and history agree.
  const lastFx = fxDays.at(-1)!;
  const fx: FxRates = { base: 'EUR', rates: lastFx.rates, asOf: `${lastFx.date}T15:00:00.000Z` };
  items.push(
    { ...keys.fx('EUR'), entityType: ENTITY.fx, ...fx },
    { ...keys.userRegistry(userId), entityType: ENTITY.user, userId, createdAt: now, updatedAt: now },
  );

  // Seed transaction dates are relative to today: remove earlier seed runs so re-seeding never duplicates.
  // The query covers every TXN# key, so it also removes items of the pre-portfolio key layout (TXN#{date}#{id}).
  const stale = await querySeedTransactionKeys(doc, tableName, userId);
  const deletes = stale.map((Key) => ({ DeleteRequest: { Key } }));
  await batchWrite(doc, tableName, deletes);
  await batchWrite(doc, tableName, items.map((Item) => ({ PutRequest: { Item } })));

  log(`Seeded user '${userId}': ${portfolios.length} portfolios, ${transactions.length} transactions, ${INSTRUMENTS.length} instruments, ` +
    `${fxDays.length} FX fixings, ${items.length} items total (EOD/FX ${eodFrom}..${today}); removed ${stale.length} stale seed transactions.`);
  return { portfolios, transactions, fxDays, itemCount: items.length, removed: stale.length };
}

async function querySeedTransactionKeys(
  doc: DynamoDBDocumentClient,
  tableName: string,
  userId: string,
  ExclusiveStartKey?: Record<string, unknown>,
): Promise<{ PK: string; SK: string }[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      FilterExpression: 'begins_with(id, :seed)',
      ExpressionAttributeValues: { ':pk': keys.user(userId).PK, ':sk': keys.transactionPrefix, ':seed': 'seed-' },
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey,
    }),
  );
  const page = (res.Items ?? []) as { PK: string; SK: string }[];
  // Each page needs the previous page's cursor, so pages are fetched sequentially.
  return res.LastEvaluatedKey ? [...page, ...(await querySeedTransactionKeys(doc, tableName, userId, res.LastEvaluatedKey))] : page;
}

type WriteRequest = { PutRequest?: { Item: Record<string, unknown> }; DeleteRequest?: { Key: Record<string, unknown> } };

/** Writes one batch, retrying unprocessed items with exponential backoff (each retry depends on the previous response). */
async function writeChunk(doc: DynamoDBDocumentClient, tableName: string, pending: WriteRequest[], attempt = 0): Promise<void> {
  if (attempt > 8) throw new Error('BatchWrite: unprocessed items remain after retries');
  if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(100 * 2 ** attempt, 3000)));
  const res = await doc.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
  const unprocessed = (res.UnprocessedItems?.[tableName] ?? []) as WriteRequest[];
  if (unprocessed.length > 0) await writeChunk(doc, tableName, unprocessed, attempt + 1);
}

async function batchWrite(doc: DynamoDBDocumentClient, tableName: string, requests: WriteRequest[], concurrency = 8) {
  const chunks: WriteRequest[][] = [];
  for (let i = 0; i < requests.length; i += 25) chunks.push(requests.slice(i, i + 25));
  let next = 0;
  // Workers drain a shared queue so at most `concurrency` batches are in flight.
  const worker = async (): Promise<void> => {
    if (next >= chunks.length) return;
    await writeChunk(doc, tableName, chunks[next++]!);
    return worker();
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
}

export function createLocalDocClient() {
  for (const [k, v] of Object.entries(LOCAL_ENV)) process.env[k] ??= v;
  const client = new DynamoDBClient({ region: process.env.AWS_REGION, endpoint: process.env.AWS_ENDPOINT_URL || undefined });
  return { client, doc: DynamoDBDocumentClient.from(client), tableName: process.env.TABLE_NAME! };
}

async function main() {
  const { client, doc, tableName } = createLocalDocClient();
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (err) {
    const name = (err as Error).name;
    const reason = name === 'ResourceNotFoundException' ? `table '${tableName}' does not exist` : `cannot reach DynamoDB at ${process.env.AWS_ENDPOINT_URL} (${(err as Error).message || (err as { code?: string }).code || name})`;
    console.error(`\n✖ Seed aborted: ${reason}.\n  Start LocalStack first (it creates the table): docker compose up -d\n`);
    process.exit(1);
  }
  await seed({ doc, tableName, userId: process.env.SEED_USER_ID ?? 'demo' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
