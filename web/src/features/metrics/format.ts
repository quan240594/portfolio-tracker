import { LOCALE, formatPercent } from '../../lib/format';

const MINUS = '\u2212';
const withMinus = (s: string) => s.replace('-', MINUS);

const oneDecimal = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const threeDecimals = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const wholeNumber = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

/** Price/earnings multiple: "25,4×". */
export const formatMultiple = (v: number): string => `${oneDecimal.format(v)}×`;
/** Gauge tick of a multiple: "20×". */
export const formatMultipleTick = (v: number): string => `${wholeNumber.format(v)}×`;
/** Sharpe, Sortino and beta, three decimals: "0,787", "−0,120". */
export const formatRatio = (v: number): string => withMinus(threeDecimals.format(v));
/** Gauge tick of a ratio: "−1", "2". */
export const formatRatioTick = (v: number): string => withMinus(wholeNumber.format(v));
/** Annualised volatility, one decimal: "12,3%". */
export const formatVolatility = (v: number): string => formatPercent(v, { digits: 1 });
/** Gauge tick of a volatility scale: "20%". */
export const formatVolatilityTick = (v: number): string => formatPercent(v, { digits: 0 });
/** Return in percent, one decimal and an explicit sign: "+45,9%". */
export const formatReturn = (v: number): string => formatPercent(v, { signed: true, digits: 1 });
/** Percentage points, one decimal: "7,8 pp". */
export const formatPoints = (v: number): string => `${oneDecimal.format(Math.abs(v))} pp`;
/** Share of a whole in percent, no decimals: "83%". */
export const formatShare = (v: number): string => formatPercent(v, { digits: 0 });
