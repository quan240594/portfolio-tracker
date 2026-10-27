import { formatDate, formatMoney } from '../../lib/format';
import { useProjectedRestOfYear } from './useProjectedRestOfYear';

/** "Projected rest of year: € X" on the dividends card: what is still declared or estimated for this calendar year, whatever period is selected. */
export function ProjectedRestOfYear() {
  const { amount, currency, isError, isPending, yearEnd } = useProjectedRestOfYear();
  let text = '…';
  if (isError) text = 'unavailable';
  else if (!isPending && amount !== undefined) text = formatMoney(amount, currency);
  return (
    <span className="muted" title={`Declared and estimated dividends still to be received until ${formatDate(yearEnd)}; not affected by the period`}>
      Projected rest of year: <span className="font-medium tabular-nums">{text}</span>
    </span>
  );
}
