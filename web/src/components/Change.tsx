import { BASE_CURRENCY, formatMoney, formatPercent, trendOf } from '../lib/format';

const trendClass = { up: 'gain-text', down: 'loss-text', flat: 'muted' } as const;
const arrow = { up: '▲', down: '▼', flat: '■' } as const;
const srLabel = { up: 'up', down: 'down', flat: 'unchanged' } as const;

interface Props {
  /** Drives the colour/arrow. Defaults to `amount ?? pct`. */
  value?: number;
  amount?: number;
  pct?: number;
  currency?: string;
  /** Decimals of the percentage (default 2). */
  digits?: number;
  className?: string;
}

/** Gain/loss indicator: colour + arrow + explicit sign, so colour is never the only signal. */
export function Change({ value, amount, pct, currency = BASE_CURRENCY, digits, className = '' }: Readonly<Props>) {
  const trend = trendOf(value ?? amount ?? pct ?? 0);
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap font-medium tabular-nums ${trendClass[trend]} ${className}`}>
      <span aria-hidden="true" className="text-[0.7em]">
        {arrow[trend]}
      </span>
      <span className="sr-only">{srLabel[trend]}</span>
      {amount !== undefined && <span>{formatMoney(amount, currency, { signed: true })}</span>}
      {pct !== undefined && <span>{amount !== undefined ? `(${formatPercent(pct, { signed: true, digits })})` : formatPercent(pct, { signed: true, digits })}</span>}
    </span>
  );
}
