import { buildInflationReply, ecbInflationSeriesKey, type InflationArea, type InflationPoint } from '@portfolio/shared';
import type { InflationFetch } from '../inflation/source.js';

export const FAKE_ECB_LATEST_MONTH = '2026-09';

/** A deterministic invented monthly series from January 1999 to `FAKE_ECB_LATEST_MONTH` (not real data); the Netherlands run 0.3 points higher. */
export function fakeInflationPoints(area: InflationArea = 'U2'): InflationPoint[] {
  const points: InflationPoint[] = [];
  for (let index = 0, year = 1999, month = 1; ; index++) {
    const label = `${year}-${String(month).padStart(2, '0')}`;
    points.push({ month: label, ratePct: Math.round((2 + 1.5 * Math.sin(index / 9) + (area === 'NL' ? 0.3 : 0)) * 10) / 10 });
    if (label === FAKE_ECB_LATEST_MONTH) return points;
    if (month === 12) {
      year++;
      month = 1;
    } else month++;
  }
}

export interface FakeEcb {
  /** The `fetch` to inject: answers the ECB data URL of the HICP series of an area with the invented series. */
  fetch: InflationFetch;
  /** Every URL asked for. */
  requests: string[];
  /** When set, the next requests fail with this HTTP status (0 = the network is down) until it is cleared. */
  failWith: number | null;
}

/** A stand-in for the ECB Data Portal: no network, one invented series per area. */
export function fakeEcb(): FakeEcb {
  const ecb: FakeEcb = {
    requests: [],
    failWith: null,
    fetch: (url) => {
      ecb.requests.push(url);
      if (ecb.failWith === 0) return Promise.reject(new TypeError('network down'));
      if (ecb.failWith !== null) return Promise.resolve(new Response('', { status: ecb.failWith }));
      const area = (['U2', 'NL'] as const).find((a) => url.includes(`/ICP/${ecbInflationSeriesKey(a)}?`));
      if (!url.startsWith('https://data-api.ecb.europa.eu/service/data/') || area === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
      return Promise.resolve(new Response(buildInflationReply(fakeInflationPoints(area)), { headers: { 'content-type': 'application/vnd.sdmx.data+json' } }));
    },
  };
  return ecb;
}
