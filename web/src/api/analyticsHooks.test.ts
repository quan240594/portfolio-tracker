import { QueryClient } from '@tanstack/react-query';
import { analyticsKeys, ANALYTICS_ROOT_KEY } from './analyticsHooks';
import { analyticsApi } from './analyticsClient';
import { invalidatePortfolioData } from './hooks';

describe('analytics query keys', () => {
  it('nest the scope right below the root so portfolio invalidation reaches them', async () => {
    const keys = [
      analyticsKeys.summary('all'),
      analyticsKeys.summary('all', 'ytd'),
      analyticsKeys.returns('p1', 'month'),
      analyticsKeys.risk('p1', 'IWDA.AS'),
      analyticsKeys.benchmark('p1', 'IWDA.AS', '1Y'),
      analyticsKeys.dividendGrowth('p2'),
      analyticsKeys.goal('p1', { targetIncome: 1 }),
    ];
    expect(keys.every((k) => k[0] === ANALYTICS_ROOT_KEY)).toBe(true);
    const qc = new QueryClient();
    for (const k of keys) qc.setQueryData(k, {});
    await invalidatePortfolioData(qc, 'p1');
    expect(keys.map((k) => qc.getQueryState(k)?.isInvalidated)).toEqual([true, true, true, true, true, false, true]);
  });
});

describe('analyticsApi', () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      calls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
  });
  const path = (i: number) => {
    const url = new URL(calls[i]!);
    return `${url.pathname}?${url.searchParams.toString()}`;
  };

  it('sends the dashboard period of the summary only when there is one', async () => {
    await analyticsApi.summary('p1', undefined, 'ttm');
    await analyticsApi.summary('all', undefined, undefined);
    expect(calls.map((_, i) => path(i))).toEqual(['/api/analytics/summary?portfolioId=p1&period=ttm', '/api/analytics/summary?']);
    expect(analyticsKeys.summary('all')).toEqual(['analytics', 'all', 'summary']);
    expect(analyticsKeys.summary('all', 'ttm')).toEqual(['analytics', 'all', 'summary', 'ttm']);
  });

  it('scopes every request and sends the parameters', async () => {
    await analyticsApi.summary('all');
    await analyticsApi.returns('p1', 'quarter');
    await analyticsApi.risk('all', 'VWRL.AS');
    await analyticsApi.benchmark('p1', 'IWDA.AS', '3M');
    await analyticsApi.dividendGrowth('p1');
    await analyticsApi.goal('all', { targetIncome: 5000, reinvestDividends: false, currentYieldPct: undefined });
    expect(calls.map((_, i) => path(i))).toEqual([
      '/api/analytics/summary?',
      '/api/analytics/returns?portfolioId=p1&period=quarter',
      '/api/analytics/risk?benchmark=VWRL.AS',
      '/api/analytics/benchmark?portfolioId=p1&benchmark=IWDA.AS&range=3M',
      '/api/analytics/dividend-growth?portfolioId=p1',
      '/api/analytics/goal?targetIncome=5000&reinvestDividends=false',
    ]);
  });
});
