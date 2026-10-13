/** ISO-4217 currency code, e.g. "EUR", "USD". */
export type Currency = string;
/** Calendar date in YYYY-MM-DD. */
export type IsoDate = string;
/** Full ISO-8601 timestamp. */
export type IsoDateTime = string;

export const ASSET_CLASSES = ['STOCK', 'ETF', 'CRYPTO', 'BOND', 'CASH', 'OTHER'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const TRANSACTION_TYPES = ['BUY', 'SELL', 'DIVIDEND'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * For BUY/SELL: quantity = units, price = per-unit price, fee = broker fee.
 * For DIVIDEND: quantity = eligible units, price = gross dividend per unit, fee = withholding tax.
 * All amounts are in `currency` (the instrument's trading currency).
 */
export interface Transaction {
  id: string;
  userId: string;
  date: IsoDate;
  type: TransactionType;
  symbol: string;
  quantity: number;
  price: number;
  fee: number;
  currency: Currency;
  note?: string;
  /**
   * FX rate the broker applied at execution: units of `currency` per 1 unit of the portfolio base
   * currency (ECB convention, e.g. 1.0842 for USD with base EUR). Takes precedence over the ECB
   * historical rate for the trade date. Omit for trades in the base currency.
   */
  fxRate?: number;
  importId?: string;
  createdAt: IsoDateTime;
}

export interface Quote {
  symbol: string;
  price: number;
  previousClose: number;
  currency: Currency;
  asOf: IsoDateTime;
  source: string;
}

export interface InstrumentProfile {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  sector?: string;
  country?: string;
  exchange?: string;
  currency: Currency;
}

export interface EodPrice {
  symbol: string;
  date: IsoDate;
  close: number;
  currency: Currency;
}

/** A corporate dividend event announced for an instrument (per-share amounts). */
export interface DividendEvent {
  symbol: string;
  exDate: IsoDate;
  payDate?: IsoDate;
  amount: number;
  currency: Currency;
}

/** ECB convention: `rates[C]` = units of C per 1 unit of `base`. `rates[base]` is implicitly 1. */
export interface FxRates {
  base: Currency;
  rates: Record<Currency, number>;
  asOf: IsoDateTime;
}

/** Daily ECB reference rates (business days only), same convention as FxRates. */
export interface FxDay {
  base: Currency;
  date: IsoDate;
  rates: Record<Currency, number>;
}

/** All monetary fields on Holding/Summary are in the portfolio base currency unless suffixed `Local`. */
export interface Holding {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  sector: string;
  country: string;
  currency: Currency;
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
  baseCurrency: Currency;
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
  asOf: IsoDateTime;
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
  date: IsoDate;
  value: number;
  invested: number;
}

export interface DividendPayment {
  symbol: string;
  date: IsoDate;
  perShareLocal: number;
  currency: Currency;
  /** Net amount in base currency. */
  amount: number;
  status: 'RECEIVED' | 'UPCOMING';
}

export interface DividendOverview {
  baseCurrency: Currency;
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
  fileName: string;
  status: ImportStatusValue;
  rowCount?: number;
  importedCount?: number;
  errors?: { row: number; message: string }[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Registry item listing every symbol any user holds; drives the scheduled price refresh. */
export interface TrackedTicker {
  symbol: string;
  currency?: Currency;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
