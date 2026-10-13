import { formatDate, formatMoney, formatMonth } from '../../lib/format';

/** Pure formatter factories for Recharts axes/tooltips/legends (kept out of JSX so they are unit-testable). */

export const compactMoneyTick = (currency: string) => (v: number) => formatMoney(v, currency, { compact: true });

/** Ranges longer than ~200 days get month/year ticks, shorter ones day/month. */
export function dateTickFormatter(points: readonly { date: string }[]): (d: string) => string {
  const first = points[0];
  const last = points.at(-1);
  const spanDays = first && last ? (Date.parse(last.date) - Date.parse(first.date)) / 86_400_000 : 0;
  const opts: Intl.DateTimeFormatOptions = spanDays > 200 ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' };
  return (d) => formatDate(d, opts);
}

export const dateLabel = (d: unknown) => formatDate(String(d));
export const monthLabel = (m: unknown) => formatMonth(String(m));

export const valueSeriesName = (name: unknown) => (name === 'value' ? 'Value' : 'Invested');
export const dividendSeriesName = (name: unknown) => (name === 'received' ? 'Received' : 'Upcoming');

/** Tooltip formatter: money value in `currency`, series name mapped through `nameOf`. */
export const moneyTooltip =
  (currency: string, nameOf: (name: unknown) => string = String) =>
  (v: unknown, name: unknown): [string, string] => [formatMoney(Number(v), currency), nameOf(name)];
