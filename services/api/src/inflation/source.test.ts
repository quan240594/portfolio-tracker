import { buildInflationReply } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { fakeInflationPoints } from '../testing/inflation-fakes.js';
import { ECB_DATA_URL, EcbInflationSource, InflationSourceError, type InflationFetch } from './source.js';

const body = (): string => buildInflationReply(fakeInflationPoints('U2'));
const answer = (text: string, init: ResponseInit = {}): InflationFetch => () => Promise.resolve(new Response(text, init));

const failure = async (source: EcbInflationSource): Promise<InflationSourceError> => {
  const error = await source.fetchSeries('U2').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(InflationSourceError);
  return error as InflationSourceError;
};

describe('EcbInflationSource', () => {
  it('asks the HICP annual-rate series of the area since 1999 and returns its points', async () => {
    const urls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];
    const source = new EcbInflationSource({
      fetch: (url, init) => {
        urls.push(url);
        inits.push(init);
        return Promise.resolve(new Response(body()));
      },
    });
    const series = await source.fetchSeries('NL');
    expect(urls).toEqual([`${ECB_DATA_URL}/ICP/M.NL.N.000000.4.ANR?format=jsondata&detail=dataonly&startPeriod=1999-01`]);
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(inits[0]?.headers).toEqual({ accept: 'application/json' });
    expect(series.series).toBe('ICP.M.NL.N.000000.4.ANR');
    expect(series.points).toEqual(fakeInflationPoints('U2'));
  });

  it('sends no credentials: the request carries only an accept header and the series in the URL', async () => {
    let seen: RequestInit | undefined;
    await new EcbInflationSource({ fetch: (_url, init) => ((seen = init), Promise.resolve(new Response(body()))) }).fetchSeries('U2');
    expect(Object.keys(seen?.headers ?? {})).toEqual(['accept']);
  });

  it('refuses a reply that is not the expected series', async () => {
    const error = await failure(new EcbInflationSource({ fetch: answer('{"dataSets":[]}') }));
    expect(error).toMatchObject({ code: 'MALFORMED', message: 'The ECB reply is not the expected series: unexpected structure' });
    expect((await failure(new EcbInflationSource({ fetch: answer('<html>maintenance</html>') }))).code).toBe('MALFORMED');
  });

  it('reports an HTTP error status', async () => {
    expect(await failure(new EcbInflationSource({ fetch: answer('nope', { status: 503 }) }))).toMatchObject({ code: 'HTTP', message: 'The ECB answered 503' });
    expect((await failure(new EcbInflationSource({ fetch: answer('', { status: 404 }) }))).code).toBe('HTTP');
  });

  it('reports a network failure and a timeout (the request carries a timeout signal)', async () => {
    const down = new EcbInflationSource({ fetch: () => Promise.reject(new TypeError('fetch failed')) });
    expect(await failure(down)).toMatchObject({ code: 'NETWORK' });
    const slow = new EcbInflationSource({ fetch: () => Promise.reject(new DOMException('The operation timed out', 'TimeoutError')) });
    expect(await failure(slow)).toMatchObject({ code: 'TIMEOUT' });
    const aborted = new EcbInflationSource({ fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')) });
    expect(await failure(aborted)).toMatchObject({ code: 'TIMEOUT' });
    const odd = new EcbInflationSource({ fetch: () => Promise.reject('plain text') });
    expect(await failure(odd)).toMatchObject({ code: 'NETWORK' });
  });

  it('refuses a reply that declares or turns out to be larger than the cap, without reading it all', async () => {
    const declared = new EcbInflationSource({ fetch: answer(body(), { headers: { 'content-length': '5000000' } }), maxBytes: 1000 });
    expect(await failure(declared)).toMatchObject({ code: 'TOO_LARGE' });
    const streamed = new EcbInflationSource({ fetch: answer(body()), maxBytes: 1000 });
    expect(await failure(streamed)).toMatchObject({ code: 'TOO_LARGE' });
    const fits = new EcbInflationSource({ fetch: answer(body()), maxBytes: body().length });
    expect((await fits.fetchSeries('U2')).points.length).toBeGreaterThan(300);
  });

  it('turns a body that fails while it is read into a network error', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    expect(await failure(new EcbInflationSource({ fetch: () => Promise.resolve(new Response(broken)) }))).toMatchObject({ code: 'NETWORK' });
  });

  it('treats an empty body as a malformed reply', async () => {
    const empty = new Response(null, { status: 200 });
    expect(await failure(new EcbInflationSource({ fetch: () => Promise.resolve(empty) }))).toMatchObject({ code: 'MALFORMED' });
  });
});
