/**
 * "Heavy personal" dataset: 30 holdings in USD / EUR / GBP + crypto, 5 years of daily prices (~40k EOD rows), FX
 * fixings, ~1,500 transactions, ~600 dividend events, 3 portfolios, categories, custom assets, a watchlist.
 *
 * Deterministic (fixed seeds, fixed "today"); price and FX walks reuse the real seed's generators
 * (`generateCloses`, `generateFxDays`, imported from services/api/scripts/seed.ts).
 */
import {
  CALENDAR_ENTITY,
  DEFAULT_PORTFOLIO_ID,
  DEFAULT_PORTFOLIO_NAME,
  ENTITY,
  GOAL_ENTITY,
  MANAGEMENT_ENTITY,
  cashSymbol,
  defaultGoalSettings,
  goalKeys,
  keys,
  managementKeys,
  type Category,
  type CategoryAssignment,
  type CustomAsset,
  type DividendEvent,
  type FxDay,
  type InstrumentProfile,
  type Portfolio,
  type PortfolioSettings,
  type Quote,
  type Transaction,
  type WatchlistEntry,
} from '../../../../../packages/shared/src/index.js';
import { generateCloses, generateFxDays } from '../../../../../services/api/scripts/seed.js';
import { calendarSeedItems } from '../../../../../services/api/scripts/calendar-seed.js';
import { SPIKE_TODAY, SPIKE_USER } from './baseline.js';
import { countByEntity, type Dataset, type Item } from './types.js';

export interface HeavyOptions {
  today?: string;
  userId?: string;
  years?: number;
  /** Total transactions to aim for (dividends included). */
  transactions?: number;
}

type Ccy = 'USD' | 'EUR' | 'GBP';
interface Div {
  /** Payments per year. */
  freq: 1 | 2 | 4 | 12;
  /** Per-share amount of the first payment, instrument currency. */
  amount: number;
  /** Yearly growth of the payment. */
  growth: number;
}
interface Inst {
  symbol: string;
  name: string;
  assetClass: 'STOCK' | 'ETF' | 'CRYPTO';
  sector: string;
  country: string;
  exchange: string;
  currency: Ccy;
  p0: number;
  drift: number;
  sigma: number;
  crypto?: boolean;
  div?: Div;
  pe?: number;
  split?: { date: string; ratio: number };
  portfolio: string;
}

const T212 = 'trading-212';
const CRYPTO_PF = 'crypto';
const I = (
  symbol: string, name: string, assetClass: Inst['assetClass'], sector: string, country: string, exchange: string, currency: Ccy,
  p0: number, drift: number, sigma: number, extra: Partial<Inst> = {},
): Inst => ({ symbol, name, assetClass, sector, country, exchange, currency, p0, drift, sigma, portfolio: currency === 'USD' ? T212 : DEFAULT_PORTFOLIO_ID, ...extra });

/** 30 holdings: 12 USD, 10 EUR, 5 GBP, 3 crypto. */
export const HEAVY_INSTRUMENTS: Inst[] = [
  I('AAPL', 'Apple Inc.', 'STOCK', 'Technology', 'United States', 'NASDAQ', 'USD', 185, 0.1, 0.014, { pe: 31, div: { freq: 4, amount: 0.22, growth: 0.05 } }),
  I('MSFT', 'Microsoft Corp.', 'STOCK', 'Technology', 'United States', 'NASDAQ', 'USD', 375, 0.12, 0.013, { pe: 34, div: { freq: 4, amount: 0.68, growth: 0.1 } }),
  I('GOOGL', 'Alphabet Inc.', 'STOCK', 'Communication', 'United States', 'NASDAQ', 'USD', 140, 0.11, 0.016, { pe: 25 }),
  I('AMZN', 'Amazon.com Inc.', 'STOCK', 'Consumer Cyclical', 'United States', 'NASDAQ', 'USD', 170, 0.1, 0.017, { pe: 42 }),
  I('NVDA', 'NVIDIA Corp.', 'STOCK', 'Technology', 'United States', 'NASDAQ', 'USD', 480, 0.3, 0.025, { pe: 55, split: { date: '2024-03-01', ratio: 4 } }),
  I('KO', 'Coca-Cola Co.', 'STOCK', 'Consumer Defensive', 'United States', 'NYSE', 'USD', 60, 0.05, 0.008, { pe: 24, div: { freq: 4, amount: 0.42, growth: 0.04 } }),
  I('JNJ', 'Johnson & Johnson', 'STOCK', 'Healthcare', 'United States', 'NYSE', 'USD', 160, 0.03, 0.009, { pe: 15, div: { freq: 4, amount: 1.13, growth: 0.05 } }),
  I('PG', 'Procter & Gamble', 'STOCK', 'Consumer Defensive', 'United States', 'NYSE', 'USD', 150, 0.05, 0.009, { pe: 26, div: { freq: 4, amount: 0.91, growth: 0.05 } }),
  I('V', 'Visa Inc.', 'STOCK', 'Financial', 'United States', 'NYSE', 'USD', 230, 0.09, 0.011, { pe: 29, div: { freq: 4, amount: 0.45, growth: 0.15 } }),
  I('O', 'Realty Income Corp.', 'STOCK', 'Real Estate', 'United States', 'NYSE', 'USD', 57, 0.01, 0.011, { pe: 38, div: { freq: 12, amount: 0.25, growth: 0.03 } }),
  I('SCHD', 'Schwab US Dividend Equity ETF', 'ETF', 'Diversified', 'United States', 'NYSE', 'USD', 72, 0.06, 0.009, { div: { freq: 12, amount: 0.22, growth: 0.08 } }),
  I('JEPI', 'JPMorgan Equity Premium Income ETF', 'ETF', 'Diversified', 'United States', 'NYSE', 'USD', 54, 0.03, 0.007, { div: { freq: 12, amount: 0.38, growth: 0.0 } }),
  I('ASML.AS', 'ASML Holding N.V.', 'STOCK', 'Technology', 'Netherlands', 'Euronext Amsterdam', 'EUR', 680, 0.08, 0.02, { pe: 38, div: { freq: 4, amount: 1.6, growth: 0.1 } }),
  I('SAP.DE', 'SAP SE', 'STOCK', 'Technology', 'Germany', 'XETRA', 'EUR', 150, 0.12, 0.015, { pe: 50, div: { freq: 1, amount: 2.2, growth: 0.04 } }),
  I('MC.PA', 'LVMH', 'STOCK', 'Consumer Cyclical', 'France', 'Euronext Paris', 'EUR', 780, 0.0, 0.017, { pe: 22, div: { freq: 2, amount: 6, growth: 0.06 } }),
  I('SIE.DE', 'Siemens AG', 'STOCK', 'Industrials', 'Germany', 'XETRA', 'EUR', 150, 0.1, 0.014, { pe: 17, div: { freq: 1, amount: 4.7, growth: 0.06 } }),
  I('ALV.DE', 'Allianz SE', 'STOCK', 'Financial', 'Germany', 'XETRA', 'EUR', 220, 0.1, 0.012, { pe: 12, div: { freq: 1, amount: 11.4, growth: 0.07 } }),
  I('TTE.PA', 'TotalEnergies SE', 'STOCK', 'Energy', 'France', 'Euronext Paris', 'EUR', 58, 0.04, 0.014, { pe: 8, div: { freq: 4, amount: 0.7, growth: 0.04 } }),
  I('VWRL.AS', 'Vanguard FTSE All-World UCITS ETF', 'ETF', 'Diversified', 'Global', 'Euronext Amsterdam', 'EUR', 105, 0.09, 0.008, { div: { freq: 4, amount: 0.45, growth: 0.05 } }),
  I('IWDA.AS', 'iShares Core MSCI World UCITS ETF', 'ETF', 'Diversified', 'Global', 'Euronext Amsterdam', 'EUR', 82, 0.09, 0.008),
  I('EMIM.AS', 'iShares Core MSCI EM IMI UCITS ETF', 'ETF', 'Diversified', 'Global', 'Euronext Amsterdam', 'EUR', 30, 0.03, 0.01),
  I('EXSA.DE', 'iShares STOXX Europe 600 UCITS ETF', 'ETF', 'Diversified', 'Global', 'XETRA', 'EUR', 40, 0.05, 0.01, { div: { freq: 2, amount: 0.55, growth: 0.04 } }),
  I('SHEL.L', 'Shell plc', 'STOCK', 'Energy', 'United Kingdom', 'LSE', 'GBP', 24, 0.06, 0.014, { pe: 9, div: { freq: 4, amount: 0.25, growth: 0.06 } }),
  I('ULVR.L', 'Unilever plc', 'STOCK', 'Consumer Defensive', 'United Kingdom', 'LSE', 'GBP', 40, 0.02, 0.01, { pe: 20, div: { freq: 4, amount: 0.37, growth: 0.04 } }),
  I('AZN.L', 'AstraZeneca plc', 'STOCK', 'Healthcare', 'United Kingdom', 'LSE', 'GBP', 105, 0.09, 0.012, { pe: 35, div: { freq: 2, amount: 1.0, growth: 0.04 } }),
  I('HSBA.L', 'HSBC Holdings plc', 'STOCK', 'Financial', 'United Kingdom', 'LSE', 'GBP', 6.2, 0.08, 0.013, { pe: 8, div: { freq: 2, amount: 0.25, growth: 0.1 } }),
  I('VUSA.L', 'Vanguard S&P 500 UCITS ETF', 'ETF', 'Diversified', 'United States', 'LSE', 'GBP', 70, 0.1, 0.009, { div: { freq: 4, amount: 0.3, growth: 0.06 } }),
  I('BTC-EUR', 'Bitcoin', 'CRYPTO', 'Crypto', 'Global', 'CCC', 'EUR', 40000, 0.25, 0.03, { crypto: true, portfolio: CRYPTO_PF }),
  I('ETH-EUR', 'Ethereum', 'CRYPTO', 'Crypto', 'Global', 'CCC', 'EUR', 2300, 0.2, 0.035, { crypto: true, portfolio: CRYPTO_PF }),
  I('SOL-EUR', 'Solana', 'CRYPTO', 'Crypto', 'Global', 'CCC', 'EUR', 90, 0.3, 0.045, { crypto: true, portfolio: CRYPTO_PF }),
];

/** Watchlist-only symbols: about one year of history (what an enrichment backfill gives). */
const WATCH_ONLY: Inst[] = [
  I('TSLA', 'Tesla Inc.', 'STOCK', 'Consumer Cyclical', 'United States', 'NASDAQ', 'USD', 240, 0.1, 0.03),
  I('META', 'Meta Platforms', 'STOCK', 'Communication', 'United States', 'NASDAQ', 'USD', 350, 0.15, 0.02),
  I('ADBE', 'Adobe Inc.', 'STOCK', 'Technology', 'United States', 'NASDAQ', 'USD', 540, 0.02, 0.017),
  I('NESN.SW', 'Nestlé S.A.', 'STOCK', 'Consumer Defensive', 'Switzerland', 'SIX', 'EUR', 95, 0.0, 0.01),
  I('ADS.DE', 'adidas AG', 'STOCK', 'Consumer Cyclical', 'Germany', 'XETRA', 'EUR', 190, 0.06, 0.02),
];

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
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const isWeekend = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
const weekdayOnOrBefore = (date: string) => {
  let d = date;
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
};

interface Series {
  dates: string[];
  closes: number[];
}
function lastOnOrBefore(s: Series, date: string): number | undefined {
  let lo = 0;
  let hi = s.dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.dates[mid]! <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans < 0 ? undefined : s.closes[ans];
}

const CATEGORIES: { id: string; name: string; color: string; target: number; match: (i: Inst) => boolean }[] = [
  { id: 'cat-core', name: 'Core ETFs', color: '#2563eb', target: 35, match: (i) => i.assetClass === 'ETF' && i.sector === 'Diversified' && !i.div },
  { id: 'cat-income', name: 'Dividend income', color: '#16a34a', target: 25, match: (i) => !!i.div },
  { id: 'cat-growth', name: 'Growth stocks', color: '#f97316', target: 20, match: (i) => i.assetClass === 'STOCK' && !i.div },
  { id: 'cat-crypto', name: 'Crypto', color: '#f59e0b', target: 8, match: (i) => i.assetClass === 'CRYPTO' },
  { id: 'cat-other', name: 'Savings & private', color: '#9333ea', target: 7, match: () => false },
  { id: 'cat-spare', name: 'Opportunistic', color: '#0ea5e9', target: 5, match: () => false },
];

export function buildHeavy(opts: HeavyOptions = {}): Dataset {
  const today = opts.today ?? SPIKE_TODAY;
  const userId = opts.userId ?? SPIKE_USER;
  const years = opts.years ?? 5;
  const targetTxns = opts.transactions ?? 1500;
  const from = addDays(today, -Math.round(365.25 * years));
  const now = `${today}T12:00:00.000Z`;
  const rng = mulberry32(20261015);
  const items: Item[] = [];
  const put = (key: { PK: string; SK: string }, entityType: string, item: object) => items.push({ ...key, entityType, ...item });

  // ---- prices (30 held over 5y, 5 watch-only over ~1y), ~3.5% of weekdays dropped as exchange holidays
  const watchFrom = addDays(today, -380);
  const series = new Map<string, Series>();
  const makeSeries = (inst: Inst, start: string) => {
    const raw = generateCloses({ profile: { symbol: inst.symbol }, p0: inst.p0, drift: inst.drift, sigma: inst.sigma, crypto: inst.crypto } as never, start, today);
    const dates: string[] = [];
    const closes: number[] = [];
    for (const [date, close] of raw) {
      if (!inst.crypto && hash(`${inst.symbol}|${date}`) % 1000 < 35) continue;
      dates.push(date);
      closes.push(close);
    }
    series.set(inst.symbol, { dates, closes });
  };
  for (const inst of HEAVY_INSTRUMENTS) makeSeries(inst, from);
  for (const inst of WATCH_ONLY) makeSeries(inst, watchFrom);
  const closeOn = (symbol: string, date: string) => lastOnOrBefore(series.get(symbol)!, date) ?? series.get(symbol)!.closes[0]!;

  const all = [...HEAVY_INSTRUMENTS, ...WATCH_ONLY];
  for (const inst of all) {
    const { symbol, currency } = inst;
    const profile: InstrumentProfile = {
      symbol,
      name: inst.name,
      assetClass: inst.assetClass,
      sector: inst.sector,
      country: inst.country,
      exchange: inst.exchange,
      currency,
      ...(inst.pe === undefined ? {} : { peRatio: inst.pe, fundamentalsAsOf: today }),
    };
    put(keys.profile(symbol), ENTITY.profile, profile);
    put(keys.trackedTicker(symbol), ENTITY.trackedTicker, { symbol, currency, createdAt: now, updatedAt: now });
    const s = series.get(symbol)!;
    for (let i = 0; i < s.dates.length; i++) put(keys.eod(symbol, s.dates[i]!), ENTITY.eod, { symbol, date: s.dates[i]!, close: s.closes[i]!, currency });
    const n = s.dates.length;
    const quote: Quote = { symbol, price: s.closes[n - 1]!, previousClose: s.closes[n - 2]!, currency, asOf: `${s.dates[n - 1]}T17:30:00.000Z`, source: 'spike' };
    put(keys.quote(symbol), ENTITY.quote, quote);
  }

  // ---- FX (ECB business days; USD/GBP/CHF), the same generator as the demo seed
  const fxDays: FxDay[] = generateFxDays(addDays(from, -10), today);
  for (const d of fxDays) put(keys.fxDay(d.base, d.date), ENTITY.fxDay, d);
  const lastFx = fxDays.at(-1)!;
  put(keys.fx('EUR'), ENTITY.fx, { base: 'EUR', rates: lastFx.rates, asOf: `${lastFx.date}T15:00:00.000Z` });
  const fxOn = (ccy: string, date: string) => {
    for (let i = fxDays.length - 1; i >= 0; i--) if (fxDays[i]!.date <= date) return fxDays[i]!.rates[ccy]!;
    return fxDays[0]!.rates[ccy]!;
  };

  // ---- dividend events (declared by the provider): one per payment, ex-date 10 days before the pay date
  const divEvents: DividendEvent[] = [];
  for (const inst of HEAVY_INSTRUMENTS) {
    if (!inst.div) continue;
    const step = 365.25 / inst.div.freq;
    const offset = Math.floor(rng() * step);
    // providers list payments from before the first purchase too
    for (let t = addDays(from, -345 + offset); t <= addDays(today, 90); t = addDays(t, Math.round(step))) {
      const yearsIn = (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (365.25 * 86_400_000);
      const amount = round(inst.div.amount * (1 + inst.div.growth) ** Math.floor(yearsIn), 4);
      const exDate = weekdayOnOrBefore(addDays(t, -10));
      divEvents.push({ symbol: inst.symbol, exDate, payDate: weekdayOnOrBefore(t), amount, currency: inst.currency });
    }
  }
  for (const e of divEvents) put(keys.dividendEvent(e.symbol, e.exDate), ENTITY.dividendEvent, e);

  // ---- transactions
  interface Intent { date: string; kind: 'BUY' | 'SELL' | 'DIV' | 'SPLIT'; inst: Inst; event?: DividendEvent; amountEur?: number }
  const intents: Intent[] = [];
  const equityLike = HEAVY_INSTRUMENTS;
  const pickDate = (a: string, b: string, crypto: boolean) => {
    const span = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
    const d = addDays(a, Math.floor(rng() * span));
    return crypto ? d : weekdayOnOrBefore(d);
  };
  const lastTxnDate = addDays(today, -2);
  // monthly savings plan: 12 holdings every month
  for (let m = 0; m < years * 12; m++) {
    const monthStart = addDays(from, Math.round(m * 30.44) + 7);
    const picks = [...equityLike].sort(() => rng() - 0.5).slice(0, 12);
    for (const inst of picks) {
      const date = weekdayOnOrBefore(addDays(monthStart, Math.floor(rng() * 20)));
      if (date <= lastTxnDate) intents.push({ date: inst.crypto ? addDays(monthStart, 3) : date, kind: 'BUY', inst, amountEur: 150 + Math.floor(rng() * 700) });
    }
  }
  for (const inst of HEAVY_INSTRUMENTS) {
    if (inst.split) intents.push({ date: inst.split.date, kind: 'SPLIT', inst });
    // every holding gets an early first purchase so it is held for most of the five years
    intents.push({ date: pickDate(addDays(from, 5), addDays(from, 120), !!inst.crypto), kind: 'BUY', inst, amountEur: 800 + Math.floor(rng() * 1500) });
  }
  for (const e of divEvents) {
    const inst = HEAVY_INSTRUMENTS.find((x) => x.symbol === e.symbol)!;
    if ((e.payDate ?? e.exDate) <= lastTxnDate) intents.push({ date: e.payDate ?? e.exDate, kind: 'DIV', inst, event: e });
  }
  const adhocSells = 120;
  for (let i = 0; i < adhocSells; i++) {
    const inst = equityLike[Math.floor(rng() * equityLike.length)]!;
    intents.push({ date: pickDate(addDays(from, 200), lastTxnDate, !!inst.crypto), kind: 'SELL', inst });
  }
  const order = (a: Intent, b: Intent) => a.date.localeCompare(b.date) || (a.kind === 'DIV' ? 1 : 0) - (b.kind === 'DIV' ? 1 : 0);

  const transactions: Transaction[] = [];
  const position = new Map<string, number>(); // `${portfolio}|${symbol}` -> units
  let seq = 0;
  const mk = (t: Omit<Transaction, 'id' | 'userId' | 'createdAt'>): Transaction => {
    seq++;
    return { id: `heavy-${String(seq).padStart(5, '0')}`, userId, createdAt: `${t.date}T10:00:00.${String(seq % 1000).padStart(3, '0')}Z`, ...t };
  };
  const process = (list: Intent[]) => {
    for (const it of list.sort(order)) {
      const { inst } = it;
      const key = `${inst.portfolio}|${inst.symbol}`;
      const held = position.get(key) ?? 0;
      if (it.kind === 'BUY') {
        const price = round(closeOn(inst.symbol, it.date) * (inst.split && it.date < inst.split.date ? inst.split.ratio : 1), 4);
        const fxr = inst.currency === 'EUR' ? 1 : fxOn(inst.currency, it.date);
        let qty = (it.amountEur ?? 300) / (price / fxr);
        qty = inst.crypto ? round(qty, 5) : inst.assetClass === 'ETF' ? round(qty, 2) : Math.max(1, Math.floor(qty));
        const txn = mk({
          portfolioId: inst.portfolio, date: it.date, type: 'BUY', symbol: inst.symbol, quantity: qty, price,
          fee: inst.currency === 'EUR' ? 1 : 1.5, currency: inst.currency, note: 'Spike',
          ...(inst.currency !== 'EUR' && rng() < 0.3 ? { fxRate: round(fxr * 0.9975, 4) } : {}),
        });
        transactions.push(txn);
        position.set(key, held + qty);
      } else if (it.kind === 'SELL') {
        if (held <= 0) continue;
        const frac = 0.1 + rng() * 0.35;
        const qty = inst.crypto ? round(held * frac, 5) : inst.assetClass === 'ETF' ? round(held * frac, 2) : Math.floor(held * frac);
        if (qty <= 0) continue;
        const price = round(closeOn(inst.symbol, it.date) * (inst.split && it.date < inst.split.date ? inst.split.ratio : 1), 4);
        transactions.push(mk({ portfolioId: inst.portfolio, date: it.date, type: 'SELL', symbol: inst.symbol, quantity: qty, price, fee: 1.5, currency: inst.currency, note: 'Spike' }));
        position.set(key, held - qty);
      } else if (it.kind === 'SPLIT') {
        if (held <= 0) continue;
        transactions.push(mk({ portfolioId: inst.portfolio, date: it.date, type: 'SPLIT', symbol: inst.symbol, quantity: inst.split!.ratio, price: 0, fee: 0, currency: inst.currency, note: 'Spike' }));
        position.set(key, held * inst.split!.ratio);
      } else if (held > 0 && it.event) {
        // DIVIDEND: quantity = eligible shares, price = gross per share, fee = withholding tax (15% US, 0 elsewhere)
        const gross = it.event.amount;
        const wht = inst.currency === 'USD' ? round(held * gross * 0.15, 2) : 0;
        transactions.push(mk({ portfolioId: inst.portfolio, date: it.date, type: 'DIVIDEND', symbol: inst.symbol, quantity: held, price: gross, fee: wht, currency: inst.currency, note: 'Spike' }));
      }
    }
  };
  process(intents);

  // cash movements of the main portfolio (cash tracking is on there)
  const cash = (date: string, type: 'DEPOSIT' | 'WITHDRAWAL' | 'INTEREST' | 'FEE', amount: number) =>
    mk({ portfolioId: DEFAULT_PORTFOLIO_ID, date, type, symbol: cashSymbol('EUR'), quantity: amount, price: 1, fee: 0, currency: 'EUR', note: 'Spike' });
  const cashTxns: Transaction[] = [];
  for (let m = 0; m < years * 12; m++) {
    const date = weekdayOnOrBefore(addDays(from, Math.round(m * 30.44) + 1));
    if (date > lastTxnDate) continue;
    cashTxns.push(cash(date, 'DEPOSIT', 1500 + (m % 4) * 250));
    if (m % 3 === 1) cashTxns.push(cash(weekdayOnOrBefore(addDays(date, 14)), 'INTEREST', round(8 + rng() * 10, 2)));
    if (m % 5 === 4) cashTxns.push(cash(weekdayOnOrBefore(addDays(date, 10)), 'FEE', 4.5));
    if (m % 12 === 11) cashTxns.push(cash(weekdayOnOrBefore(addDays(date, 5)), 'WITHDRAWAL', 2500));
  }
  transactions.push(...cashTxns);

  // top up with extra BUYs (oldest-first replay is unnecessary for buys: they only add units)
  while (transactions.length < targetTxns) {
    const inst = equityLike[Math.floor(rng() * equityLike.length)]!;
    const date = pickDate(addDays(from, 130), lastTxnDate, !!inst.crypto);
    const price = round(closeOn(inst.symbol, date) * (inst.split && date < inst.split.date ? inst.split.ratio : 1), 4);
    const fxr = inst.currency === 'EUR' ? 1 : fxOn(inst.currency, date);
    const raw = (100 + Math.floor(rng() * 500)) / (price / fxr);
    const qty = inst.crypto ? round(raw, 5) : inst.assetClass === 'ETF' ? round(raw, 2) : Math.max(1, Math.floor(raw));
    transactions.push(mk({ portfolioId: inst.portfolio, date, type: 'BUY', symbol: inst.symbol, quantity: qty, price, fee: 1, currency: inst.currency, note: 'Spike' }));
  }
  for (const t of transactions) put(keys.transaction(userId, t.portfolioId, t.date, t.id), ENTITY.transaction, t);

  // ---- portfolios, settings, categories, assignments, custom assets, watchlist, goal, registry, calendar
  const ts0 = `${addDays(from, -1)}T00:00:00.000Z`;
  const portfolios: Portfolio[] = [
    { portfolioId: DEFAULT_PORTFOLIO_ID, userId, name: DEFAULT_PORTFOLIO_NAME, createdAt: ts0, updatedAt: ts0 },
    { portfolioId: T212, userId, name: 'Trading 212', createdAt: `${addDays(from, -1)}T00:00:01.000Z`, updatedAt: ts0 },
    { portfolioId: CRYPTO_PF, userId, name: 'Crypto', createdAt: `${addDays(from, -1)}T00:00:02.000Z`, updatedAt: ts0 },
  ];
  for (const p of portfolios) put(keys.portfolio(userId, p.portfolioId), ENTITY.portfolio, p);
  const settings: PortfolioSettings = { portfolioId: DEFAULT_PORTFOLIO_ID, userId, trackCash: true, withholdingTaxRate: 15, updatedAt: now };
  put(managementKeys.settings(userId, DEFAULT_PORTFOLIO_ID), MANAGEMENT_ENTITY.settings, settings);

  // categories and assignments for the main portfolio (rebalance endpoint input)
  CATEGORIES.forEach((c, i) => {
    const category: Category = { categoryId: c.id, userId, portfolioId: DEFAULT_PORTFOLIO_ID, name: c.name, color: c.color, targetWeight: c.target, createdAt: `${ts0.slice(0, 19)}.00${i}Z`, updatedAt: ts0 };
    put(managementKeys.category(userId, DEFAULT_PORTFOLIO_ID, c.id), MANAGEMENT_ENTITY.category, category);
  });
  const mainSymbols = new Set(transactions.filter((t) => t.portfolioId === DEFAULT_PORTFOLIO_ID).map((t) => t.symbol));
  for (const inst of HEAVY_INSTRUMENTS) {
    if (!mainSymbols.has(inst.symbol)) continue;
    const cat = CATEGORIES.find((c) => c.match(inst));
    if (!cat) continue;
    const a: CategoryAssignment = { userId, portfolioId: DEFAULT_PORTFOLIO_ID, symbol: inst.symbol, categoryId: cat.id };
    put(managementKeys.assignment(userId, DEFAULT_PORTFOLIO_ID, inst.symbol), MANAGEMENT_ENTITY.categoryAssignment, a);
  }
  const assets: CustomAsset[] = [
    { assetId: 'asset-savings', userId, portfolioId: DEFAULT_PORTFOLIO_ID, name: 'Savings account', assetClass: 'DEPOSIT', currency: 'EUR', costBasis: 20000, growthRate: 2.5, valuations: [{ date: addDays(today, -900), value: 20000 }], createdAt: ts0, updatedAt: ts0 },
    { assetId: 'asset-flat', userId, portfolioId: DEFAULT_PORTFOLIO_ID, name: 'Apartment share', assetClass: 'REAL_ESTATE', currency: 'EUR', costBasis: 60000, growthRate: 3, valuations: [{ date: addDays(today, -1200), value: 60000 }, { date: addDays(today, -400), value: 66000 }], createdAt: ts0, updatedAt: ts0 },
    { assetId: 'asset-p2p', userId, portfolioId: DEFAULT_PORTFOLIO_ID, name: 'P2P loans', assetClass: 'OTHER', currency: 'EUR', costBasis: 5000, valuations: [{ date: addDays(today, -300), value: 5000 }, { date: addDays(today, -100), value: 5200 }], createdAt: ts0, updatedAt: ts0 },
  ];
  for (const a of assets) {
    put(managementKeys.customAsset(userId, a.portfolioId, a.assetId), MANAGEMENT_ENTITY.customAsset, a);
    const as: CategoryAssignment = { userId, portfolioId: DEFAULT_PORTFOLIO_ID, symbol: `CUSTOM:${a.assetId}`, categoryId: 'cat-other' };
    put(managementKeys.assignment(userId, DEFAULT_PORTFOLIO_ID, as.symbol), MANAGEMENT_ENTITY.categoryAssignment, as);
  }
  WATCH_ONLY.forEach((w, i) => {
    const entry: WatchlistEntry = { userId, symbol: w.symbol, addedAt: `${addDays(today, -30 - i)}T10:00:00.000Z` };
    put(managementKeys.watchlist(userId, w.symbol), MANAGEMENT_ENTITY.watchlist, entry);
  });
  put(goalKeys.goal(userId, 'all'), GOAL_ENTITY, { ...defaultGoalSettings(today), userId, portfolioId: 'all', createdAt: now, updatedAt: now });
  put(keys.userRegistry(userId), ENTITY.user, { userId, createdAt: now, updatedAt: now });
  for (const it of calendarSeedItems(today, now)) items.push(it as Item);
  // earnings for the US holdings (watch window), like the calendar refresh job writes them
  for (const inst of HEAVY_INSTRUMENTS.filter((x) => x.currency === 'USD' && x.assetClass === 'STOCK')) {
    const date = weekdayOnOrBefore(addDays(today, 10 + (hash(inst.symbol) % 50)));
    items.push({ PK: `TICKER#${inst.symbol}`, SK: `EARN#${date}`, entityType: CALENDAR_ENTITY.earnings, symbol: inst.symbol, date, name: inst.name, epsEstimate: 1.5, currency: 'USD', timeOfDay: 'AMC', source: 'spike', updatedAt: now });
  }

  return { name: 'heavy-personal', userId, today, items, counts: countByEntity(items) };
}
