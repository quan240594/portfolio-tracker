import { averageInflation } from '@portfolio/shared';
import { apiUrl } from '../api/client';
import { MOCK_INFLATION_LATEST_MONTH, mockInflationPoints } from './inflationHandlers';

describe('mock inflation API (the demo)', () => {
  it('serves the invented euro-area series by default, monthly from 1999 to the latest month', async () => {
    const body = await (await fetch(apiUrl('/inflation'))).json();
    expect(body).toMatchObject({ area: 'U2', series: 'ICP.M.U2.N.000000.4.ANR', latestMonth: MOCK_INFLATION_LATEST_MONTH, stale: false });
    expect(body.points[0]).toEqual({ month: '1999-01', ratePct: 2 });
    expect(body.points.at(-1).month).toBe(MOCK_INFLATION_LATEST_MONTH);
    expect(body.points).toHaveLength(27 * 12 + 9);
  });

  it('serves the Netherlands 0.3 points higher and rejects an unknown area', async () => {
    const dutch = await (await fetch(apiUrl('/inflation?area=NL'))).json();
    expect(dutch).toMatchObject({ area: 'NL', series: 'ICP.M.NL.N.000000.4.ANR' });
    expect(dutch.points[0].ratePct).toBeCloseTo(mockInflationPoints('U2')[0]!.ratePct + 0.3, 5);
    expect((await fetch(apiUrl('/inflation?area=FR'))).status).toBe(400);
  });

  it('covers every horizon of the helper', () => {
    const points = mockInflationPoints('U2');
    for (const horizon of ['5y', '10y', '20y', 'all'] as const) expect(averageInflation(points, horizon, { min: 0, max: 30 }).available).toBe(true);
  });
});
