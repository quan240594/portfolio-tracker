/**
 * Deterministic demo data for MSW (tests + `pnpm dev:mock`). Prices follow a seeded random walk that
 * ends at a fixed "current" price on today's date, so values are realistic but stable within a day.
 */
import type {
  Category,
  CategoryAssignment,
  CustomAsset,
  DividendEvent,
  EodPrice,
  FxDay,
  FxRates,
  InstrumentProfile,
  PortfolioSettings,
  Quote,
  Transaction,
  WatchlistEntry,
} from '@portfolio/shared';
import { DEFAULT_PORTFOLIO_ID, FxTimeline, buildPositions, cashSymbol, customSymbol } from '@portfolio/shared';

export const MOCK_USER_ID = 'demo';
/** Second demo portfolio: the US stocks live at "Trading 212", everything else in the default portfolio. */
export const TRADING_212_ID = 'trading-212';
export const TRADING_212_NAME = 'Trading 212';
const TRADING_212_SYMBOLS = new Set(['AAPL', 'MSFT', 'KO', 'JNJ']);
export const seedPortfolioOf = (symbol: string) => (TRADING_212_SYMBOLS.has(symbol) ? TRADING_212_ID : DEFAULT_PORTFOLIO_ID);
export const BASE_CURRENCY: string = 'EUR';

interface InstrumentSeed extends InstrumentProfile {
  price: number;
  annualDrift: number;
  dailyVol: number;
  tradesWeekends?: boolean;
}

export const INSTRUMENTS: InstrumentSeed[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'STOCK', sector: 'Technology', country: 'United States', exchange: 'NASDAQ', currency: 'USD', price: 228.52, annualDrift: 0.18, dailyVol: 0.015 },
  { symbol: 'MSFT', name: 'Microsoft Corporation', assetClass: 'STOCK', sector: 'Technology', country: 'United States', exchange: 'NASDAQ', currency: 'USD', price: 418.16, annualDrift: 0.14, dailyVol: 0.013 },
  { symbol: 'KO', name: 'The Coca-Cola Company', assetClass: 'STOCK', sector: 'Consumer Staples', country: 'United States', exchange: 'NYSE', currency: 'USD', price: 69.84, annualDrift: 0.06, dailyVol: 0.008 },
  { symbol: 'JNJ', name: 'Johnson & Johnson', assetClass: 'STOCK', sector: 'Healthcare', country: 'United States', exchange: 'NYSE', currency: 'USD', price: 158.41, annualDrift: -0.03, dailyVol: 0.009 },
  { symbol: 'VWRL.AS', name: 'Vanguard FTSE All-World UCITS ETF (Dist)', assetClass: 'ETF', sector: 'Diversified', country: 'Global', exchange: 'Euronext Amsterdam', currency: 'EUR', price: 121.38, annualDrift: 0.15, dailyVol: 0.007 },
  { symbol: 'IWDA.AS', name: 'iShares Core MSCI World UCITS ETF (Acc)', assetClass: 'ETF', sector: 'Diversified', country: 'Global', exchange: 'Euronext Amsterdam', currency: 'EUR', price: 98.74, annualDrift: 0.16, dailyVol: 0.007 },
  { symbol: 'ASML.AS', name: 'ASML Holding N.V.', assetClass: 'STOCK', sector: 'Technology', country: 'Netherlands', exchange: 'Euronext Amsterdam', currency: 'EUR', price: 712.3, annualDrift: 0.02, dailyVol: 0.022 },
  { symbol: 'BTC-EUR', name: 'Bitcoin', assetClass: 'CRYPTO', sector: 'Digital Assets', country: 'Global', currency: 'EUR', price: 56_820, annualDrift: 0.55, dailyVol: 0.03, tradesWeekends: true },
  // Watchlist-only instruments (no transactions).
  { symbol: 'NVDA', name: 'NVIDIA Corporation', assetClass: 'STOCK', sector: 'Technology', country: 'United States', exchange: 'NASDAQ', currency: 'USD', price: 131.4, annualDrift: 0.35, dailyVol: 0.024 },
  { symbol: 'SAP.DE', name: 'SAP SE', assetClass: 'STOCK', sector: 'Technology', country: 'Germany', exchange: 'XETRA', currency: 'EUR', price: 231.9, annualDrift: 0.12, dailyVol: 0.014 },
  { symbol: 'ETH-EUR', name: 'Ethereum', assetClass: 'CRYPTO', sector: 'Digital Assets', country: 'Global', currency: 'EUR', price: 2_410, annualDrift: 0.3, dailyVol: 0.035, tradesWeekends: true },
];

/** Symbols the mock API reports with `priceStale: true`, to exercise the UI indicator. */
export const STALE_SYMBOLS = new Set(['IWDA.AS']);

const HISTORY_DAYS = 400;
/** Past dividend events reach further back than the transactions, like the ~2 years the data provider returns. */
const EVENT_HISTORY_DAYS = 900;

/**
 * EUR/USD (USD per 1 EUR) drifts from ~1.04 a year ago to ~1.17 today: the euro strengthened, so US
 * holdings show a negative currency effect in EUR.
 */
export const USD_PER_EUR_START = 1.035;
export const USD_PER_EUR_END = 1.17;
/** Broker FX spread on top of the ECB fixing (the broker gives fewer USD per EUR). */
const BROKER_FX_SPREAD = 0.0025;

/** Wraps to a signed 32-bit integer (what `| 0` does), which Math.trunc would not. */
const toInt32 = (n: number) => Math.imul(n, 1);

function mulberry32(seed: number) {
  let a = toInt32(seed);
  return () => {
    a = toInt32(a + 0x6d2b79f5);
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (s: string) => [...s].reduce((h, c) => toInt32(Math.imul(h, 31) + (c.codePointAt(0) ?? 0)), 7);

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
};
const isWeekend = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};
/** Nearest trading day on or before `date`. */
const tradingDay = (date: string): string => {
  let d = date;
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
};

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

export interface MockMarket {
  today: string;
  /** Latest rates (equal to the most recent day in `fxHistory`). */
  fx: FxRates;
  /** Daily ECB-style fixings over the full history window (business days only). */
  fxHistory: FxDay[];
  profiles: Record<string, InstrumentProfile>;
  eod: Record<string, EodPrice[]>;
  quotes: Record<string, Quote>;
  dividendEvents: DividendEvent[];
}

/** Portfolio-management data of the demo: cash tracking, categories with targets, custom assets, watchlist. */
export interface ManagementSeed {
  settings: PortfolioSettings[];
  categories: Category[];
  assignments: CategoryAssignment[];
  assets: CustomAsset[];
  watchlist: WatchlistEntry[];
}

export interface MockSeed extends MockMarket {
  transactions: Transaction[];
  management: ManagementSeed;
}

function buildEod(seed: InstrumentSeed, today: string): EodPrice[] {
  const rnd = mulberry32(hash(seed.symbol));
  const dpDigits = seed.price > 1000 ? 0 : 2;
  const prices: EodPrice[] = [];
  let price = seed.price;
  const dailyDrift = seed.annualDrift / 365;
  for (let i = 0; i <= HISTORY_DAYS; i++) {
    const date = addDays(today, -i);
    if (!seed.tradesWeekends && isWeekend(date)) continue;
    prices.push({ symbol: seed.symbol, date, close: round(price, dpDigits), currency: seed.currency });
    const shock = (rnd() + rnd() + rnd() - 1.5) * 2 * seed.dailyVol;
    price = price / (1 + dailyDrift + shock);
  }
  return prices.reverse();
}

/** Seeded daily EUR/USD fixings with a linear trend plus small noise; weekends are skipped like the ECB. */
export function buildFxHistory(today: string): FxDay[] {
  const rnd = mulberry32(hash('EURUSD'));
  const days: FxDay[] = [];
  for (let i = HISTORY_DAYS; i >= 0; i--) {
    const date = addDays(today, -i);
    const noise = (rnd() - 0.5) * 0.008;
    if (isWeekend(date)) continue;
    const trend = USD_PER_EUR_END - ((USD_PER_EUR_END - USD_PER_EUR_START) * i) / HISTORY_DAYS;
    days.push({ base: BASE_CURRENCY, date, rates: { USD: round(trend + (i === 0 ? 0 : noise), 4) } });
  }
  return days;
}

export function closeOn(eod: readonly EodPrice[], date: string): number {
  let close = eod[0]?.close ?? 0;
  for (const p of eod) {
    if (p.date > date) break;
    close = p.close;
  }
  return close;
}

interface DividendSchedule {
  symbol: string;
  perShare: number;
  everyDays: number;
  /** Days ago of the most recent payment. */
  lastPaidDaysAgo: number;
  withholding: number;
  /** Yearly change of the per-share amount, going forward in time (negative = the dividend was cut). */
  growth?: number;
  /** Days between payments, newest gap first (cycled), instead of `everyDays`: an irregular payer. */
  gaps?: number[];
  /** Number of payments so far, for a payer that only just started. */
  payments?: number;
}

const DIVIDEND_SCHEDULES: DividendSchedule[] = [
  { symbol: 'AAPL', perShare: 0.25, everyDays: 91, lastPaidDaysAgo: 48, withholding: 0.15, growth: 0.04 },
  { symbol: 'MSFT', perShare: 0.83, everyDays: 91, lastPaidDaysAgo: 27, withholding: 0.15, growth: 0.1 },
  { symbol: 'KO', perShare: 0.485, everyDays: 91, lastPaidDaysAgo: 62, withholding: 0.15, growth: 0.05 },
  // An irregular payer that cut its dividend, an ETF whose distribution fell, and a stock that only paid once so far.
  { symbol: 'JNJ', perShare: 1.24, everyDays: 91, lastPaidDaysAgo: 13, withholding: 0.15, growth: -0.06, gaps: [91, 150, 60, 180, 91] },
  { symbol: 'VWRL.AS', perShare: 0.36, everyDays: 91, lastPaidDaysAgo: 34, withholding: 0, growth: -0.03 },
  { symbol: 'ASML.AS', perShare: 1.52, everyDays: 182, lastPaidDaysAgo: 75, withholding: 0.15, payments: 1 },
];

/** Days ago of every payment of a schedule, newest first, down to `maxDaysAgo`. */
function paymentDaysAgo(s: DividendSchedule, maxDaysAgo: number): number[] {
  const days: number[] = [];
  const gaps = s.gaps ?? [s.everyDays];
  for (let daysAgo = s.lastPaidDaysAgo; daysAgo < maxDaysAgo && days.length < (s.payments ?? Infinity); daysAgo += gaps[(days.length - 1) % gaps.length]!) days.push(daysAgo);
  return days;
}

/** Per-share amount paid `daysAgo` days ago: the current amount, reduced/raised by `growth` for every year back. */
const amountPaid = (s: DividendSchedule, daysAgo: number): number => round(s.perShare / (1 + (s.growth ?? 0)) ** Math.floor(daysAgo / 365), 4);

export function createSeed(now: Date = new Date()): MockSeed {
  const today = isoDay(now);
  const fxHistory = buildFxHistory(today);
  const fx: FxRates = { base: BASE_CURRENCY, rates: { EUR: 1, ...fxHistory.at(-1)!.rates }, asOf: now.toISOString() };
  const timeline = new FxTimeline(fx, fxHistory);
  const profiles: Record<string, InstrumentProfile> = {};
  const eod: Record<string, EodPrice[]> = {};
  const quotes: Record<string, Quote> = {};
  for (const inst of INSTRUMENTS) {
    const { price: _p, annualDrift: _d, dailyVol: _v, tradesWeekends: _w, ...profile } = inst;
    profiles[inst.symbol] = profile;
    const prices = buildEod(inst, today);
    eod[inst.symbol] = prices;
    const last = prices.at(-1)!;
    const prev = prices.at(-2) ?? last;
    quotes[inst.symbol] = {
      symbol: inst.symbol,
      price: last.close,
      previousClose: prev.close,
      currency: inst.currency,
      asOf: now.toISOString(),
      source: 'mock',
    };
  }

  const transactions: Transaction[] = [];
  let seq = 0;
  const push = (t: Omit<Transaction, 'id' | 'userId' | 'createdAt' | 'portfolioId'>) => {
    seq += 1;
    transactions.push({
      ...t,
      portfolioId: seedPortfolioOf(t.symbol),
      id: `txn-${String(seq).padStart(4, '0')}`,
      userId: MOCK_USER_ID,
      createdAt: `${t.date}T09:30:00.000Z`,
    });
  };
  /** `brokerFx` records the broker's FX rate (ECB fixing minus spread) on the transaction, as on a statement. */
  /** `unadjusted` multiplies the (split-adjusted) EOD close: the price actually paid before a later split. */
  const trade = (
    type: 'BUY' | 'SELL',
    symbol: string,
    daysAgo: number,
    quantity: number,
    fee: number,
    { note, brokerFx = false, unadjusted = 1 }: { note?: string; brokerFx?: boolean; unadjusted?: number } = {},
  ) => {
    const date = profiles[symbol]!.assetClass === 'CRYPTO' ? addDays(today, -daysAgo) : tradingDay(addDays(today, -daysAgo));
    const currency = profiles[symbol]!.currency;
    const fxRate = brokerFx ? round(timeline.rate(currency, date) * (1 - BROKER_FX_SPREAD), 4) : undefined;
    push({ date, type, symbol, quantity, price: round(closeOn(eod[symbol]!, date) * unadjusted, 2), fee, currency, ...(note ? { note } : {}), ...(fxRate ? { fxRate } : {}) });
  };
  /** Cash movement of the main portfolio (cash tracking is on there). */
  const cash = (type: 'DEPOSIT' | 'WITHDRAWAL' | 'INTEREST' | 'FEE', daysAgo: number, amount: number, note?: string) =>
    push({ date: tradingDay(addDays(today, -daysAgo)), type, symbol: cashSymbol('EUR'), quantity: amount, price: 1, fee: 0, currency: 'EUR', ...(note ? { note } : {}) });

  cash('DEPOSIT', 400, 30_000, 'Initial deposit');
  cash('DEPOSIT', 270, 15_000);
  cash('DEPOSIT', 100, 8_000, 'Extra savings');
  cash('WITHDRAWAL', 45, 1_000, 'Holiday');
  cash('INTEREST', 30, 14.2, 'Interest on cash');
  cash('FEE', 12, 4.95, 'Account fee');
  trade('BUY', 'VWRL.AS', 378, 80, 2, { note: 'Initial core position' });
  trade('BUY', 'AAPL', 372, 25, 1, { note: 'Broker FX rate', brokerFx: true });
  trade('BUY', 'MSFT', 365, 12, 1);
  trade('BUY', 'KO', 358, 60, 1);
  // 2-for-1 split of JNJ shortly after the purchase: 15 pre-split shares at twice the adjusted price become 30.
  trade('BUY', 'JNJ', 341, 15, 1, { note: 'Bought before the 2-for-1 split', unadjusted: 2 });
  push({ date: tradingDay(addDays(today, -330)), type: 'SPLIT', symbol: 'JNJ', quantity: 2, price: 0, fee: 0, currency: 'USD', note: '2-for-1 stock split' });
  trade('BUY', 'BTC-EUR', 330, 0.15, 4.5);
  trade('BUY', 'IWDA.AS', 301, 100, 2);
  trade('BUY', 'ASML.AS', 279, 6, 2);
  trade('BUY', 'VWRL.AS', 250, 40, 2);
  trade('BUY', 'AAPL', 201, 10, 1);
  trade('BUY', 'BTC-EUR', 152, 0.05, 2.5);
  trade('BUY', 'VWRL.AS', 131, 40, 2);
  trade('BUY', 'MSFT', 118, 5, 1, { brokerFx: true });
  trade('BUY', 'IWDA.AS', 89, 50, 2);
  trade('SELL', 'AAPL', 58, 10, 1, { note: 'Trimmed position' });
  trade('BUY', 'VWRL.AS', 19, 30, 2);

  const dividendEvents: DividendEvent[] = [];
  for (const s of DIVIDEND_SCHEDULES) {
    const currency = profiles[s.symbol]!.currency;
    for (const daysAgo of paymentDaysAgo(s, EVENT_HISTORY_DAYS)) {
      const perShare = amountPaid(s, daysAgo);
      // Past events (also from before the demo's transactions); the payments the user received are the ones in the history.
      dividendEvents.push({ symbol: s.symbol, exDate: addDays(today, -daysAgo - 14), payDate: addDays(today, -daysAgo), amount: perShare, currency });
      if (daysAgo >= HISTORY_DAYS) continue;
      const date = tradingDay(addDays(today, -daysAgo));
      const held = buildPositions(transactions, addDays(date, -14)).get(s.symbol)?.quantity ?? 0;
      if (held <= 0) continue;
      const gross = held * perShare;
      push({ date, type: 'DIVIDEND', symbol: s.symbol, quantity: held, price: perShare, fee: round(gross * s.withholding, 2), currency });
    }
    const nextPay = addDays(today, s.everyDays - s.lastPaidDaysAgo);
    dividendEvents.push({ symbol: s.symbol, exDate: addDays(nextPay, -14), payDate: nextPay, amount: s.perShare, currency });
    const following = addDays(nextPay, s.everyDays);
    if (following <= addDays(today, 200)) {
      dividendEvents.push({ symbol: s.symbol, exDate: addDays(following, -14), payDate: following, amount: s.perShare, currency });
    }
  }
  transactions.sort((a, b) => a.date.localeCompare(b.date));

  return { today, fx, fxHistory, profiles, eod, quotes, dividendEvents, transactions, management: createManagementSeed(today, now) };
}

const SEED_CATEGORY_IDS = { core: 'cat-core', stocks: 'cat-stocks', crypto: 'cat-crypto', property: 'cat-property', private: 'cat-private' } as const;
export const SAVINGS_ASSET_ID = 'asset-savings';
export const PROPERTY_ASSET_ID = 'asset-property';
export const PRIVATE_ASSET_ID = 'asset-private';

/**
 * Main portfolio: cash tracking on (15% dividend withholding), five categories whose targets add up to 100% with the
 * demo holdings drifting away from them, and three custom assets. The watchlist holds three symbols that are not owned.
 */
export function createManagementSeed(today: string, now: Date): ManagementSeed {
  const ts = now.toISOString();
  const portfolioId = DEFAULT_PORTFOLIO_ID;
  const cat = (categoryId: string, name: string, color: string, targetWeight: number, i: number): Category => ({
    categoryId,
    userId: MOCK_USER_ID,
    portfolioId,
    name,
    color,
    targetWeight,
    createdAt: `${addDays(today, -400)}T00:00:0${i}.000Z`,
    updatedAt: ts,
  });
  const asset = (p: Pick<CustomAsset, 'assetId' | 'name' | 'assetClass' | 'costBasis' | 'valuations'> & { growthRate?: number }): CustomAsset => ({
    userId: MOCK_USER_ID,
    portfolioId,
    currency: 'EUR',
    createdAt: `${addDays(today, -400)}T00:00:00.000Z`,
    updatedAt: ts,
    ...p,
  });
  const assign = (symbol: string, categoryId: string): CategoryAssignment => ({ userId: MOCK_USER_ID, portfolioId, symbol, categoryId });
  const ids = SEED_CATEGORY_IDS;
  return {
    settings: [{ portfolioId, userId: MOCK_USER_ID, trackCash: true, withholdingTaxRate: 15, updatedAt: ts }],
    categories: [
      cat(ids.core, 'Core ETFs', '#6366f1', 45, 0),
      cat(ids.stocks, 'Single stocks', '#14b8a6', 15, 1),
      cat(ids.crypto, 'Crypto', '#f59e0b', 10, 2),
      cat(ids.property, 'Property & savings', '#0ea5e9', 25, 3),
      cat(ids.private, 'Private equity', '#ec4899', 5, 4),
    ],
    assignments: [
      assign('VWRL.AS', ids.core),
      assign('IWDA.AS', ids.core),
      assign('ASML.AS', ids.stocks),
      assign('BTC-EUR', ids.crypto),
      assign(customSymbol(SAVINGS_ASSET_ID), ids.property),
      assign(customSymbol(PROPERTY_ASSET_ID), ids.property),
      assign(customSymbol(PRIVATE_ASSET_ID), ids.private),
    ],
    assets: [
      asset({ assetId: SAVINGS_ASSET_ID, name: 'Savings account', assetClass: 'DEPOSIT', costBasis: 8_000, growthRate: 2, valuations: [{ date: addDays(today, -360), value: 8_000 }] }),
      asset({
        assetId: PROPERTY_ASSET_ID,
        name: 'Rental property (share)',
        assetClass: 'REAL_ESTATE',
        costBasis: 22_000,
        valuations: [
          { date: addDays(today, -380), value: 22_000 },
          { date: addDays(today, -150), value: 24_500 },
        ],
      }),
      asset({
        assetId: PRIVATE_ASSET_ID,
        name: 'Start-up stake',
        assetClass: 'OTHER',
        costBasis: 3_000,
        valuations: [
          { date: addDays(today, -300), value: 3_000 },
          { date: addDays(today, -90), value: 3_600 },
        ],
      }),
    ],
    watchlist: [
      { userId: MOCK_USER_ID, symbol: 'NVDA', addedAt: `${addDays(today, -30)}T10:00:00.000Z` },
      { userId: MOCK_USER_ID, symbol: 'SAP.DE', addedAt: `${addDays(today, -20)}T10:00:00.000Z` },
      { userId: MOCK_USER_ID, symbol: 'ETH-EUR', addedAt: `${addDays(today, -10)}T10:00:00.000Z` },
    ],
  };
}
