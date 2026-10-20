/** Builders for Trading 212 API records, shaped after the public OpenAPI spec (synthetic data only). */
import type { CashTransaction, HistoricalOrder, HistoryDividend, OpenPosition } from '../t212/schemas.js';

export interface OrderOptions {
  id?: number | string;
  fillId?: number | string;
  side?: string;
  status?: string;
  ticker?: string;
  isin?: string;
  currency?: string;
  filledAt?: string;
  price?: number;
  quantity?: number;
  type?: string;
  walletCurrency?: string;
  fxRate?: number;
  netValue?: number;
  taxes?: { name?: string; quantity: number; currency?: string }[];
  noFill?: boolean;
  noWallet?: boolean;
}

export function order(o: OrderOptions = {}): HistoricalOrder {
  const ticker = o.ticker ?? 'AAPL_US_EQ';
  const currency = o.currency ?? 'USD';
  const price = o.price ?? 100;
  const quantity = o.quantity ?? 2;
  return {
    order: {
      id: String(o.id ?? 1),
      side: o.side ?? 'BUY',
      status: o.status ?? 'FILLED',
      ticker,
      instrument: { ticker, isin: o.isin ?? 'US0378331005', name: 'Example Corp', currency },
    },
    fill: o.noFill
      ? undefined
      : {
          id: String(o.fillId ?? 10),
          price,
          quantity,
          filledAt: o.filledAt ?? '2024-03-05T15:30:00.000+01:00',
          type: o.type ?? 'TRADE',
          walletImpact: o.noWallet
            ? undefined
            : {
                currency: o.walletCurrency ?? 'EUR',
                fxRate: o.fxRate,
                netValue: o.netValue ?? (price * quantity) / 1.09,
                taxes: o.taxes ?? [],
              },
        },
  };
}

export interface DividendOptions {
  reference?: string;
  ticker?: string;
  isin?: string;
  currency?: string;
  accountCurrency?: string;
  quantity?: number;
  amount?: number;
  grossAmountPerShare?: number;
  paidOn?: string;
  type?: string;
}

export function dividend(o: DividendOptions = {}): HistoryDividend {
  const ticker = o.ticker ?? 'AAPL_US_EQ';
  const currency = o.currency ?? 'USD';
  return {
    reference: o.reference ?? 'ref-1',
    ticker,
    instrument: { ticker, isin: o.isin ?? 'US0378331005', name: 'Example Corp', currency },
    quantity: o.quantity ?? 10,
    amount: o.amount ?? 1.6,
    grossAmountPerShare: o.grossAmountPerShare ?? 0.25,
    currency: o.accountCurrency ?? 'EUR',
    tickerCurrency: currency,
    paidOn: o.paidOn ?? '2024-05-16T00:00:00.000Z',
    type: o.type ?? 'ORDINARY',
  };
}

export const cash = (type: string, dateTime = '2024-01-02T09:00:00Z'): CashTransaction => ({
  reference: `c-${type}-${dateTime}`,
  type,
  amount: 100,
  currency: 'EUR',
  dateTime,
});

export interface PositionOptions {
  ticker?: string;
  name?: string;
  isin?: string;
  currency?: string;
  quantity?: number;
  currentPrice?: number;
  averagePricePaid?: number;
  /** Account-currency value of the position (`walletImpact.currentValue`) and its currency. */
  currentValue?: number;
  walletCurrency?: string;
  noPrice?: boolean;
}

/** An open position as `GET /api/v0/equity/positions` reports it (synthetic data only). */
export function position(o: PositionOptions = {}): OpenPosition {
  const quantity = o.quantity ?? 2;
  const currentPrice = o.currentPrice ?? 210;
  return {
    instrument: { ticker: o.ticker ?? 'AAPL_US_EQ', isin: o.isin ?? 'US0378331005', name: o.name ?? 'Example Corp', currency: o.currency ?? 'USD' },
    quantity,
    ...(o.noPrice ? {} : { currentPrice }),
    averagePricePaid: o.averagePricePaid ?? 150,
    ...(o.currentValue === undefined ? {} : { walletImpact: { currency: o.walletCurrency ?? 'EUR', currentValue: o.currentValue } }),
  };
}
