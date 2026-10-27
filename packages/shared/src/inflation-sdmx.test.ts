import { describe, expect, it } from 'vitest';
import type { InflationPoint } from './inflation-api.js';
import { MIN_INFLATION_POINTS, buildInflationReply, parseInflationReply } from './inflation-sdmx.js';

/** `count` consecutive months from January 2020 with a rate that changes every month. */
const months = (count: number): InflationPoint[] =>
  Array.from({ length: count }, (_, i) => ({ month: `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, ratePct: Math.round(i * 7) / 10 - 1 }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tests edit a reply of a known shape
const reply = (mutate: (json: any) => void, count = 36): string => {
  const json = JSON.parse(buildInflationReply(months(count)));
  mutate(json);
  return JSON.stringify(json);
};

describe('parseInflationReply', () => {
  it('reads the monthly points of a reply, oldest first', () => {
    const points = months(40);
    expect(parseInflationReply(buildInflationReply(points))).toEqual({ points });
    expect(parseInflationReply(buildInflationReply([...points].reverse()))).toEqual({ points });
  });

  it('leaves out months without a value', () => {
    const result = parseInflationReply(reply((json) => (json.dataSets[0].series['0:0:0:0:0:0'].observations['3'] = [null])));
    expect(result).toMatchObject({ points: expect.any(Array) });
    expect('points' in result && result.points).toHaveLength(35);
  });

  it('rejects text that is not JSON and replies of another shape', () => {
    expect(parseInflationReply('<html>')).toEqual({ error: 'not JSON' });
    expect(parseInflationReply('{}')).toEqual({ error: 'unexpected structure' });
    expect(parseInflationReply(reply((json) => (json.dataSets = [])))).toEqual({ error: 'unexpected structure' });
    expect(parseInflationReply(reply((json) => (json.dataSets[0].series['0:0:0:0:0:0'].observations['1'] = [])))).toEqual({ error: 'unexpected structure' });
  });

  it('wants exactly one series and a time dimension', () => {
    expect(parseInflationReply(reply((json) => (json.dataSets[0].series['1:0:0:0:0:0'] = json.dataSets[0].series['0:0:0:0:0:0'])))).toEqual({ error: 'one series with a time dimension is expected' });
    expect(parseInflationReply(reply((json) => (json.dataSets[0].series = {})))).toEqual({ error: 'one series with a time dimension is expected' });
    expect(parseInflationReply(reply((json) => (json.structure.dimensions.observation[0].id = 'OTHER')))).toEqual({ error: 'one series with a time dimension is expected' });
  });

  it('rejects unknown, malformed and repeated months', () => {
    expect(parseInflationReply(reply((json) => (json.dataSets[0].series['0:0:0:0:0:0'].observations['99'] = [2])))).toEqual({ error: 'unknown or repeated month' });
    expect(parseInflationReply(reply((json) => (json.structure.dimensions.observation[0].values[2].id = '2020-13')))).toEqual({ error: 'unknown or repeated month' });
    expect(parseInflationReply(reply((json) => (json.structure.dimensions.observation[0].values[2].id = json.structure.dimensions.observation[0].values[1].id)))).toEqual({ error: 'unknown or repeated month' });
  });

  it('rejects rates that are not plausible numbers', () => {
    for (const bad of ['2.5', 120, -80]) {
      expect(parseInflationReply(reply((json) => (json.dataSets[0].series['0:0:0:0:0:0'].observations['4'] = [bad])))).toEqual({ error: 'implausible rate' });
    }
  });

  it('rejects a series that is too short to average', () => {
    expect(parseInflationReply(buildInflationReply(months(MIN_INFLATION_POINTS - 1)))).toEqual({ error: 'too few months' });
    expect(parseInflationReply(buildInflationReply(months(MIN_INFLATION_POINTS)))).toMatchObject({ points: expect.any(Array) });
  });
});
