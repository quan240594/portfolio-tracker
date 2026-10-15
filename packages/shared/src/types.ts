
export const ASSET_CLASSES = ['STOCK', 'ETF', 'CRYPTO', 'BOND', 'CASH', 'REAL_ESTATE', 'DEPOSIT', 'OTHER'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const TRANSACTION_TYPES = ['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'SPLIT', 'FEE', 'INTEREST'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * For BUY/SELL: quantity = units, price = per-unit price, fee = broker fee.
 * For DIVIDEND: quantity = eligible units, price = gross dividend per unit, fee = withholding tax.
 * All amounts are in `currency` (the instrument's trading currency).
 * Portfolio management types (see management.ts): DEPOSIT/WITHDRAWAL/FEE/INTEREST are cash movements on symbol
 * `CASH.<currency>` (amount = quantity * price, fee must be 0); SPLIT: quantity = new shares per old share
 * (4 for 4:1, 0.1 for 1:10), fee 0, price ignored.
 */
export interface Transaction {
  id: string;
  userId: string;
  /** Portfolio the transaction belongs to (see Portfolio). */
  portfolioId: string;
  date: string;
  type: TransactionType;
  symbol: string;
  quantity: number;
  price: number;
  fee: number;
  currency: string;
  note?: string;
  /**
   * FX rate the broker applied at execution: units of `currency` per 1 unit of the portfolio base
   * currency (ECB convention, e.g. 1.0842 for USD with base EUR). Takes precedence over the ECB
   * historical rate for the trade date. Omit for trades in the base currency.
   */
  fxRate?: number;
  importId?: string;
  createdAt: string;
}

export interface Quote {
  symbol: string;
  price: number;
  previousClose: number;
  currency: string;
  asOf: string;
  source: string;
}

export interface InstrumentProfile {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  sector?: string;
  country?: string;
  exchange?: string;
  currency: string;
  /** Trailing-twelve-month price/earnings ratio; absent when unknown or not positive (ETFs, crypto, loss makers). */
  peRatio?: number;
  /** YYYY-MM-DD the `peRatio` was fetched. */
  fundamentalsAsOf?: string;

  // Optional company details for the asset detail page: absent when no provider supplies them.
  description?: string;
  /** ISIN of the instrument (12 characters). */
  isin?: string;
  /** In `currency`, whole units. */
  marketCap?: number;
  /** Trailing-twelve-month earnings per share, in `currency`. */
  eps?: number;
  beta?: number;
  /** YYYY-MM-DD the optional details above were last fetched; drives the lazy refresh TTL. */
  detailsAsOf?: string;
}

export interface EodPrice {
  symbol: string;
  date: string;
  close: number;
  currency: string;
}

/** A corporate dividend event announced for an instrument (per-share amounts). */
export interface DividendEvent {
  symbol: string;
  exDate: string;
  payDate?: string;
  amount: number;
  currency: string;
}

/** ECB convention: `rates[C]` = units of C per 1 unit of `base`. `rates[base]` is implicitly 1. */
export interface FxRates {
  base: string;
  rates: Record<string, number>;
  asOf: string;
}

/** Daily ECB reference rates (business days only), same convention as FxRates. */
export interface FxDay {
  base: string;
  date: string;
  rates: Record<string, number>;
}

/** All monetary fields on Holding/Summary are in the portfolio base currency unless suffixed `Local`. */
export interface Holding {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  sector: string;
  country: string;
  currency: string;
  quantity: number;
  averageCostLocal: number;
  priceLocal: number;
  /** Average cost per unit in base currency, at the FX rates of the original purchases. */
  averageCostBase: number;
  /** Current price per unit in base currency, at today's FX rate. */
  priceBase: number;
  priceStale: boolean;
  costBasis: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  /** Part of unrealizedPnl caused by FX moves since purchase (0 for base-currency holdings). */
  currencyEffect: number;
  dayChange: number;
  dayChangePct: number;
  realizedPnl: number;
  dividendsReceived: number;
  /** 0..1 share of total market value. */
  weight: number;
}

export interface PortfolioSummary {
  baseCurrency: string;
  totalValue: number;
  totalCost: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  /** Part of unrealizedPnl caused by FX moves since purchase. */
  currencyEffect: number;
  realizedPnl: number;
  dividendsReceived: number;
  /** unrealized + realized + dividends */
  totalReturn: number;
  totalReturnPct: number;
  dayChange: number;
  dayChangePct: number;
  holdingsCount: number;
  asOf: string;
  /** Base-currency cash balance; only present when cash tracking is on for a portfolio in scope. Included in totalValue. */
  cashValue?: number;
  /** Base-currency value of custom (non-market) assets; only present when there are any. Included in totalValue. */
  customAssetsValue?: number;
  /** Interest minus account fees on cash (base currency); part of totalReturn. Only present with cash tracking. */
  cashIncome?: number;
}

export const ALLOCATION_DIMENSIONS = ['assetClass', 'sector', 'country', 'currency', 'symbol'] as const;
export type AllocationDimension = (typeof ALLOCATION_DIMENSIONS)[number];

export interface AllocationSlice {
  key: string;
  label: string;
  value: number;
  weight: number;
}

export interface ValuePoint {
  date: string;
  value: number;
  invested: number;
}

export interface DividendPayment {
  symbol: string;
  date: string;
  perShareLocal: number;
  currency: string;
  /** Net amount in base currency. */
  amount: number;
  status: 'RECEIVED' | 'UPCOMING';
}

export interface DividendOverview {
  baseCurrency: string;
  totalReceived: number;
  last12Months: number;
  projectedNext12Months: number;
  received: DividendPayment[];
  upcoming: DividendPayment[];
  /** YYYY-MM -> net amount in base currency, received + upcoming. */
  monthly: { month: string; received: number; upcoming: number }[];
}

export const IMPORT_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;
export type ImportStatusValue = (typeof IMPORT_STATUSES)[number];

export interface ImportStatus {
  importId: string;
  userId: string;
  /** Target portfolio for the imported rows. */
  portfolioId: string;
  fileName: string;
  status: ImportStatusValue;
  rowCount?: number;
  importedCount?: number;
  errors?: { row: number; message: string }[];
  createdAt: string;
  updatedAt: string;
}

/** Registry item listing every symbol any user holds; drives the scheduled price refresh. */
export interface TrackedTicker {
  symbol: string;
  currency?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A named collection of transactions (e.g. one per broker account). All portfolios of a user share
 * the global base currency (DEFAULT_BASE_CURRENCY). Analytics endpoints work on one portfolio or on
 * all of them combined. A user always has at least one portfolio; `DEFAULT_PORTFOLIO_ID` is created
 * on first use.
 */
export interface Portfolio {
  portfolioId: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
