/**
 * Idempotently seeds the local DynamoDB table (LocalStack) with a demo portfolio.
 *   pnpm --filter @portfolio/api seed
 * Prerequisite: `docker compose up -d` (the LocalStack init hook creates the table).
 */
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { pathToFileURL } from 'node:url';
import {
  ENTITY,
  keys,
  type AssetClass,
  type DividendEvent,
  type EodPrice,
  type FxRates,
  type InstrumentProfile,
  type Quote,
  type Transaction,
  type TransactionType,
} from '@portfolio/shared';

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
  { profile: { symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'STOCK', sector: 'Technology', country: 'United States', exchange: 'NASDAQ', currency: 'USD' }, p0: 185, drift: 0.08, sigma: 0.014 },
  { profile: { symbol: 'MSFT', name: 'Microsoft Corp.', assetClass: 'STOCK', sector: 'Technology', country: 'United States', exchange: 'NASDAQ', currency: 'USD' }, p0: 375, drift: 0.1, sigma: 0.013 },
  { profile: { symbol: 'ASML.AS', name: 'ASML Holding N.V.', assetClass: 'STOCK', sector: 'Technology', country: 'Netherlands', exchange: 'Euronext Amsterdam', currency: 'EUR' }, p0: 680, drift: 0.06, sigma: 0.02 },
  { profile: { symbol: 'VWRL.AS', name: 'Vanguard FTSE All-World UCITS ETF', assetClass: 'ETF', sector: 'Diversified', country: 'Global', exchange: 'Euronext Amsterdam', currency: 'EUR' }, p0: 105, drift: 0.09, sigma: 0.008 },
  { profile: { symbol: 'IWDA.AS', name: 'iShares Core MSCI World UCITS ETF', assetClass: 'ETF', sector: 'Diversified', country: 'Global', exchange: 'Euronext Amsterdam', currency: 'EUR' }, p0: 82, drift: 0.09, sigma: 0.008 },
  { profile: { symbol: 'BTC-EUR', name: 'Bitcoin', assetClass: 'CRYPTO' as AssetClass, sector: 'Crypto', country: 'Global', exchange: 'CCC', currency: 'EUR' }, p0: 40000, drift: 0.25, sigma: 0.03, crypto: true },
];

/** [daysAgo, type, symbol, quantity, fee, dividend per unit] */
const TXNS: [number, TransactionType, string, number, number, number?][] = [
  [540, 'BUY', 'AAPL', 10, 1],
  [520, 'BUY', 'VWRL.AS', 40, 2],
  [500, 'BUY', 'MSFT', 5, 1],
  [470, 'BUY', 'ASML.AS', 4, 2],
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
];

/** [symbol, exDate offset (days from today), payDate offset, amount] */
const DIV_EVENTS: [string, number, number, number][] = [
  ['AAPL', 20, 27, 0.26],
  ['MSFT', 35, 70, 0.83],
  ['ASML.AS', 40, 47, 1.6],
  ['VWRL.AS', 60, 75, 0.45],
];

const FX_EUR: FxRates['rates'] = { USD: 1.09, GBP: 0.86, CHF: 0.94 };
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
  return dow === 6 ? addDays(date, -1) : dow === 0 ? addDays(date, -2) : date;
};
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

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
const hash = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

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

export interface SeedOptions {
  doc: DynamoDBDocumentClient;
  tableName: string;
  userId?: string;
  today?: string;
  log?: (msg: string) => void;
}

export async function seed({ doc, tableName, userId = 'demo', today = iso(new Date()), log = console.log }: SeedOptions) {
  const firstTxnDate = addDays(today, -Math.max(...TXNS.map((t) => t[0])));
  const eodFrom = addDays(today, -Math.max(MIN_EOD_DAYS, daysBetween(firstTxnDate, today) + 10));
  const now = new Date().toISOString();
  const items: Record<string, unknown>[] = [];

  const closes = new Map(INSTRUMENTS.map((i) => [i.profile.symbol, generateCloses(i, eodFrom, today)]));
  const closeOn = (symbol: string, date: string) => {
    const series = closes.get(symbol)!;
    for (let d = date; d >= eodFrom; d = addDays(d, -1)) if (series.has(d)) return series.get(d)!;
    throw new Error(`No close for ${symbol} on/before ${date}`);
  };

  for (const inst of INSTRUMENTS) {
    const { symbol, currency } = inst.profile;
    items.push({ ...keys.profile(symbol), entityType: ENTITY.profile, ...inst.profile });
    items.push({ ...keys.trackedTicker(symbol), entityType: ENTITY.trackedTicker, symbol, currency, createdAt: now, updatedAt: now });
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
    return {
      id: `seed-${String(i + 1).padStart(2, '0')}`,
      userId,
      date,
      type,
      symbol,
      quantity,
      price: type === 'DIVIDEND' ? dividend! : closeOn(symbol, date),
      fee,
      currency: inst.profile.currency,
      note: 'Demo seed',
      createdAt: `${date}T12:00:00.000Z`,
    };
  });
  for (const t of transactions) items.push({ ...keys.transaction(userId, t.date, t.id), entityType: ENTITY.transaction, ...t });

  for (const [symbol, exOff, payOff, amount] of DIV_EVENTS) {
    const inst = INSTRUMENTS.find((x) => x.profile.symbol === symbol)!;
    const ev: DividendEvent = { symbol, exDate: addDays(today, exOff), payDate: addDays(today, payOff), amount, currency: inst.profile.currency };
    items.push({ ...keys.dividendEvent(symbol, ev.exDate), entityType: ENTITY.dividendEvent, ...ev });
  }

  const fx: FxRates = { base: 'EUR', rates: FX_EUR, asOf: now };
  items.push({ ...keys.fx('EUR'), entityType: ENTITY.fx, ...fx });
  items.push({ ...keys.userRegistry(userId), entityType: ENTITY.user, userId, createdAt: now, updatedAt: now });

  // Seed transaction dates are relative to today: remove earlier seed runs so re-seeding never duplicates.
  const stale = await querySeedTransactionKeys(doc, tableName, userId);
  const deletes = stale.map((Key) => ({ DeleteRequest: { Key } }));
  await batchWrite(doc, tableName, deletes);
  await batchWrite(doc, tableName, items.map((Item) => ({ PutRequest: { Item } })));

  log(`Seeded user '${userId}': ${transactions.length} transactions, ${INSTRUMENTS.length} instruments, ` +
    `${items.length} items total (EOD ${eodFrom}..${today}); removed ${stale.length} stale seed transactions.`);
  return { transactions, itemCount: items.length };
}

async function querySeedTransactionKeys(doc: DynamoDBDocumentClient, tableName: string, userId: string) {
  const out: { PK: string; SK: string }[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
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
    out.push(...((res.Items ?? []) as { PK: string; SK: string }[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

type WriteRequest = { PutRequest?: { Item: Record<string, unknown> }; DeleteRequest?: { Key: Record<string, unknown> } };

async function batchWrite(doc: DynamoDBDocumentClient, tableName: string, requests: WriteRequest[], concurrency = 8) {
  const chunks: WriteRequest[][] = [];
  for (let i = 0; i < requests.length; i += 25) chunks.push(requests.slice(i, i + 25));
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      let pending = chunks[next++]!;
      for (let attempt = 0; pending.length > 0; attempt++) {
        if (attempt > 8) throw new Error('BatchWrite: unprocessed items remain after retries');
        if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(100 * 2 ** attempt, 3000)));
        const res = await doc.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
        pending = (res.UnprocessedItems?.[tableName] ?? []) as WriteRequest[];
      }
    }
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
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
