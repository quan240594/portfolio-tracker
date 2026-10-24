import type { ValuedAtCost } from '@portfolio/shared';
import { Link } from 'react-router-dom';
import { PRICE_COVERAGE_ANCHOR } from '../../features/diagnostics/PriceCoverageCard';
import { formatDate } from '../../lib/format';

/** The sentence of the note: how many holdings lack a price history, until when they are valued at cost. */
export function valuedAtCostText({ symbols, held, until }: Readonly<ValuedAtCost>): string {
  const lacking = symbols.length;
  const holdings = held === 1 ? 'holding' : 'holdings';
  const verb = lacking === 1 ? 'has' : 'have';
  const subject = lacking === 1 ? 'it is' : 'they are';
  return `${lacking} of ${held} ${holdings} ${verb} no price history before ${formatDate(until)}; ${subject} valued at cost until then`;
}

/** A short, non-blocking note under the "Value vs invested" title when some holdings had no stored price on some days; links to the coverage card. */
export function ValuedAtCostNote({ valuedAtCost }: Readonly<{ valuedAtCost: ValuedAtCost }>) {
  return (
    <p className="muted mt-1 text-xs" data-testid="valued-at-cost-note">
      {valuedAtCostText(valuedAtCost)} (
      <Link to={`/settings/diagnostics#${PRICE_COVERAGE_ANCHOR}`} className="underline underline-offset-2">
        details
      </Link>
      )
    </p>
  );
}
