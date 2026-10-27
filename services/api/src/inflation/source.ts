/**
 * The ECB inflation source: the monthly HICP annual rate of change of the euro area or the Netherlands, read from the ECB Data
 * Portal (SDMX REST, no key). Portable: the only I/O is the injected `fetch`, so it runs on Lambda, in a Durable Object and in tests
 * (with a fake). The reply is validated strictly (`parseInflationReply` in @portfolio/shared); anything unexpected is an
 * `InflationSourceError`, never a guess.
 *
 * Request: `GET {base}/HICP/M.{area}.N.000000.4D0.ANR?format=jsondata&detail=dataonly&startPeriod=1999-01` (SDMX-JSON 1.0 reply).
 */
import { ECB_INFLATION_FLOW, INFLATION_START_MONTH, ecbInflationSeriesKey, parseInflationReply, type InflationArea, type InflationPoint } from '@portfolio/shared';

export const ECB_DATA_URL = 'https://data-api.ecb.europa.eu/service/data';
/** The monthly series since 1999 is about 15 kB; a reply far beyond that is not the series. */
export const MAX_INFLATION_BYTES = 1_000_000;
export const INFLATION_TIMEOUT_MS = 8000;

export type InflationFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type InflationSourceErrorCode = 'HTTP' | 'TIMEOUT' | 'NETWORK' | 'TOO_LARGE' | 'MALFORMED';

export class InflationSourceError extends Error {
  constructor(
    public readonly code: InflationSourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InflationSourceError';
  }
}

export interface InflationSeries {
  /** The ECB series key that was read, `HICP.M.U2.N.000000.4D0.ANR`. */
  series: string;
  /** Oldest first, one point per month. */
  points: InflationPoint[];
}

export interface InflationSource {
  fetchSeries(area: InflationArea): Promise<InflationSeries>;
}

const malformed = (what: string): InflationSourceError => new InflationSourceError('MALFORMED', `The ECB reply is not the expected series: ${what}`);

const tooLarge = (): InflationSourceError => new InflationSourceError('TOO_LARGE', 'The ECB reply is larger than expected');

/** The body as text, refusing more than `max` bytes without reading the rest (a stalled body ends with the request's own timeout). */
async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > max) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === null) return '';
  let size = 0;
  const capped = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > max) throw tooLarge();
        controller.enqueue(chunk);
      },
    }),
  );
  try {
    return await new Response(capped).text();
  } catch (error) {
    throw error instanceof InflationSourceError ? error : new InflationSourceError('NETWORK', 'The ECB reply could not be read');
  }
}

export interface EcbInflationSourceOptions {
  fetch: InflationFetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export class EcbInflationSource implements InflationSource {
  private readonly fetchImpl: InflationFetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: EcbInflationSourceOptions) {
    this.fetchImpl = options.fetch;
    this.baseUrl = options.baseUrl ?? ECB_DATA_URL;
    this.timeoutMs = options.timeoutMs ?? INFLATION_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? MAX_INFLATION_BYTES;
  }

  async fetchSeries(area: InflationArea): Promise<InflationSeries> {
    const key = ecbInflationSeriesKey(area);
    const url = `${this.baseUrl}/${ECB_INFLATION_FLOW}/${key}?format=jsondata&detail=dataonly&startPeriod=${INFLATION_START_MONTH}`;
    const response = await this.request(url);
    if (!response.ok) {
      await response.body?.cancel();
      throw new InflationSourceError('HTTP', `The ECB answered ${response.status}`);
    }
    const text = await readCapped(response, this.maxBytes);
    const parsed = parseInflationReply(text);
    if ('error' in parsed) throw malformed(parsed.error);
    return { series: `${ECB_INFLATION_FLOW}.${key}`, points: parsed.points };
  }

  private async request(url: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new InflationSourceError(timedOut ? 'TIMEOUT' : 'NETWORK', timedOut ? 'The ECB did not answer in time' : 'The ECB could not be reached');
    }
  }
}
