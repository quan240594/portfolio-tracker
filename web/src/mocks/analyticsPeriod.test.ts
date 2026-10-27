import { apiUrl } from '../api/client';

describe('mock analytics summary (the demo)', () => {
  it('adds the figures of the requested period to the summary, for every scope', async () => {
    const plain = await (await fetch(apiUrl('/analytics/summary'))).json();
    expect(plain).not.toHaveProperty('periodPerformance');

    for (const period of ['ttm', 'ytd', '5y', '10y', 'all']) {
      const body = await (await fetch(apiUrl(`/analytics/summary?period=${period}`))).json();
      expect(body.periodPerformance).toMatchObject({ period });
      expect(typeof body.periodPerformance.totalReturn).toBe('number');
    }
    const all = await (await fetch(apiUrl('/analytics/summary?period=all'))).json();
    expect(all.periodPerformance).toMatchObject({ truncated: false, totalReturn: expect.any(Number) });
    expect(all.periodPerformance.irrPct).toBe(all.performance.irrPct);

    const scoped = await (await fetch(apiUrl('/analytics/summary?period=ttm&portfolioId=trading-212'))).json();
    expect(scoped.periodPerformance.period).toBe('ttm');
  });

  it('rejects an unknown period', async () => {
    const res = await fetch(apiUrl('/analytics/summary?period=3y'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });
});
