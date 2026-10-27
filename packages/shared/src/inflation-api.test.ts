import { describe, expect, it } from 'vitest';
import { ECB_INFLATION_FLOW, INFLATION_AREAS, inflationKeys, inflationQuerySchema, ecbInflationSeriesKey } from './inflation-api.js';

describe('inflation contract', () => {
  it('defaults the area to the euro area and refuses unknown areas', () => {
    expect(inflationQuerySchema.parse({})).toEqual({ area: 'U2' });
    expect(inflationQuerySchema.parse({ area: 'NL' })).toEqual({ area: 'NL' });
    expect(inflationQuerySchema.safeParse({ area: 'DE' }).success).toBe(false);
    expect(inflationQuerySchema.safeParse({ area: 'nl' }).success).toBe(false);
  });

  it('names the ECB HICP annual-rate series of every area', () => {
    expect(ECB_INFLATION_FLOW).toBe('HICP');
    expect(INFLATION_AREAS.map((area) => ecbInflationSeriesKey(area))).toEqual(['M.U2.N.000000.4D0.ANR', 'M.NL.N.000000.4D0.ANR']);
  });

  it('keeps one cache item per area, outside every user partition', () => {
    expect(inflationKeys.series('NL')).toEqual({ PK: 'REF#INFLATION', SK: 'AREA#NL' });
  });
});
