import { QueryClient } from '@tanstack/react-query';
import { invalidatePortfolioData, queryKeys } from './hooks';

describe('queryKeys', () => {
  it('builds stable keys that include the portfolio scope', () => {
    expect(queryKeys.portfolios).toEqual(['portfolios']);
    expect(queryKeys.portfolio('all')).toEqual(['portfolio', 'all']);
    expect(queryKeys.holdings('p1')).toEqual(['holdings', 'p1']);
    expect(queryKeys.allocation('all', 'sector')).toEqual(['allocation', 'all', 'sector']);
    expect(queryKeys.history('p1', '3M')).toEqual(['history', 'p1', '3M']);
    expect(queryKeys.dividends('p1')).toEqual(['dividends', 'p1']);
    expect(queryKeys.transactions('all')).toEqual(['transactions', 'all']);
    expect(queryKeys.import('imp-1')).toEqual(['imports', 'imp-1']);
  });
});

const scopedKeys = (scope: string) => [
  queryKeys.portfolio(scope),
  queryKeys.holdings(scope),
  queryKeys.allocation(scope, 'country'),
  queryKeys.history(scope, '1Y'),
  queryKeys.dividends(scope),
  queryKeys.transactions(scope),
];

function seed() {
  const qc = new QueryClient();
  const keys = [...scopedKeys('all'), ...scopedKeys('p1'), ...scopedKeys('p2'), queryKeys.import('imp-1'), queryKeys.portfolios];
  for (const key of keys) qc.setQueryData(key, { ok: true });
  const invalidated = () => keys.filter((key) => qc.getQueryState(key)?.isInvalidated);
  return { qc, invalidated };
}

describe('invalidatePortfolioData', () => {
  it('invalidates every scope of every transaction-derived query, but not imports or the portfolio list', async () => {
    const { qc, invalidated } = seed();
    await expect(invalidatePortfolioData(qc)).resolves.toBeUndefined();
    expect(invalidated()).toEqual([...scopedKeys('all'), ...scopedKeys('p1'), ...scopedKeys('p2')]);
  });

  it('limits invalidation to one portfolio plus the combined view', async () => {
    const { qc, invalidated } = seed();
    await invalidatePortfolioData(qc, 'p1');
    expect(invalidated()).toEqual([...scopedKeys('all'), ...scopedKeys('p1')]);
  });

  it('invalidates only the combined view for the "all" scope', async () => {
    const { qc, invalidated } = seed();
    await invalidatePortfolioData(qc, 'all');
    expect(invalidated()).toEqual(scopedKeys('all'));
  });
});
