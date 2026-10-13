import { QueryClient } from '@tanstack/react-query';
import { invalidatePortfolioData, queryKeys } from './hooks';

describe('queryKeys', () => {
  it('builds stable, parameterised keys', () => {
    expect(queryKeys.portfolio).toEqual(['portfolio']);
    expect(queryKeys.allocation('sector')).toEqual(['allocation', 'sector']);
    expect(queryKeys.history('3M')).toEqual(['history', '3M']);
    expect(queryKeys.import('imp-1')).toEqual(['imports', 'imp-1']);
  });
});

describe('invalidatePortfolioData', () => {
  it('invalidates every transaction-derived query but not import status', async () => {
    const qc = new QueryClient();
    const keys = [
      queryKeys.portfolio,
      queryKeys.holdings,
      queryKeys.allocation('country'),
      queryKeys.history('1Y'),
      queryKeys.dividends,
      queryKeys.transactions,
      queryKeys.import('imp-1'),
    ];
    for (const key of keys) qc.setQueryData(key, { ok: true });

    await expect(invalidatePortfolioData(qc)).resolves.toBeUndefined();
    const invalidated = keys.filter((key) => qc.getQueryState(key)?.isInvalidated);
    expect(invalidated).toEqual(keys.slice(0, -1));
  });
});
