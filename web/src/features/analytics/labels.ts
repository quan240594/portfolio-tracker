import type { ReturnPeriod } from '@portfolio/shared';
import { LOCALE, formatMonth, formatPercent } from '../../lib/format';

/** `2026` / `Q1 2026` / `Mar 26` for the period keys returned by GET /analytics/returns. */
export function periodLabel(period: ReturnPeriod, key: string): string {
  if (period === 'month') return formatMonth(key);
  if (period === 'quarter') {
    const [year, quarter] = key.split('-');
    return `${quarter} ${year}`;
  }
  return key;
}

/** Axis tick for a percentage without decimals ("12%"). */
export const percentTick = (v: number): string => formatPercent(v, { digits: 0 });

/** "+12,34%" or an em dash when there is no value. */
export const signedPercentOrDash = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined ? '—' : formatPercent(v, { signed: true, digits });

const ratioFormat = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Unit-less ratios such as Sharpe or beta: "1,23", "−0,50" or an em dash. */
export const ratioOrDash = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : ratioFormat.format(v).replace('-', '\u2212');
