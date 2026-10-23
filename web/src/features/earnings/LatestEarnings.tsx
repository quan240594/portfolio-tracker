import { Link } from 'react-router-dom';
import { useEarnings, useEarningsStatus } from '../../api/earningsHooks';
import { EarningsCard } from './EarningsCard';

/**
 * The newest earnings summary of the security on its detail page, with a link to all of them. Renders nothing until the deployment reports the
 * feature as available and there is a summary: no placeholder, no empty box.
 */
export function LatestEarnings({ symbol }: Readonly<{ symbol: string }>) {
  const status = useEarningsStatus();
  const available = status.data?.available === true && status.data.configured;
  const list = useEarnings({ symbol, limit: 1 }, { enabled: available });
  const latest = list.data?.summaries[0];
  if (!available || latest === undefined) return null;
  return (
    <section aria-labelledby="latest-earnings-heading" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="latest-earnings-heading" className="text-base font-semibold">
          Latest earnings
        </h2>
        <Link to={`/earnings/${encodeURIComponent(symbol)}`} className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-100">
          All earnings summaries of {symbol}
        </Link>
      </div>
      <EarningsCard summary={latest} variant="compact" />
    </section>
  );
}
