/**
 * EPS consensus ("expected") from Alpha Vantage `EARNINGS` (quarterly `reportedEPS` / `estimatedEPS`), the only free source for it. It needs
 * the optional `ALPHAVANTAGE_API_KEY` and spends one call of the 25 a day (shared with the profile and calendar jobs through the same
 * `DailyQuota`), one per symbol per release. This is the estimate a summary is stored with; the analyst consensus (EPS and revenue per fiscal
 * quarter, with range and analyst count) is fetched separately by the `earningsEstimates` job (`estimates-job.ts`) and joined by the API. Free cash flow
 * and guidance have no free legitimate consensus source: the UI says "no estimate available".
 */
import { DailyQuota, alphaVantageSymbol } from '@portfolio/prices';
import { daysBetween } from '@portfolio/shared';
import type { EpsEstimate } from './derive.js';

const ALPHAVANTAGE_URL = 'https://www.alphavantage.co/query';
/** The release date of the filing and the date Alpha Vantage recorded may differ by a day or two. */
const MATCH_DAYS = 4;

export type EstimateOutcome = { status: 'ok'; estimate: EpsEstimate } | { status: 'no-key' | 'not-listed' | 'quota' | 'no-entry' | 'error' };

export interface EstimateSource {
  epsEstimate(symbol: string, reportDate: string): Promise<EstimateOutcome>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function number(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  return Number.isFinite(parsed) && String(value).trim() !== '' ? parsed : undefined;
}

/** The quarterly entry reported within four days of `reportDate`, with its estimate; `undefined` when there is none. */
export function pickEstimate(json: unknown, reportDate: string): EpsEstimate | undefined {
  const quarters = isRecord(json) && Array.isArray(json.quarterlyEarnings) ? json.quarterlyEarnings : [];
  let best: { gap: number; estimate: EpsEstimate } | undefined;
  for (const entry of quarters) {
    if (!isRecord(entry) || typeof entry.reportedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.reportedDate)) continue;
    const estimate = number(entry.estimatedEPS);
    if (estimate === undefined) continue;
    const gap = Math.abs(daysBetween(entry.reportedDate, reportDate));
    if (gap > MATCH_DAYS || (best !== undefined && best.gap <= gap)) continue;
    const reportedEps = number(entry.reportedEPS);
    best = { gap, estimate: { estimate, ...(reportedEps === undefined ? {} : { reportedEps }) } };
  }
  return best?.estimate;
}

export interface AlphaVantageEstimatesOptions {
  apiKey: string | undefined;
  /** The alarm's counted `fetch`. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  quota: DailyQuota;
  /** Resolves when a request to Alpha Vantage may start (`ProviderPacer.wait`); absent: no waiting. */
  pace?: () => Promise<unknown>;
}

export class AlphaVantageEstimates implements EstimateSource {
  constructor(private readonly options: AlphaVantageEstimatesOptions) {}

  async epsEstimate(symbol: string, reportDate: string): Promise<EstimateOutcome> {
    const { apiKey, quota } = this.options;
    if (apiKey === undefined || apiKey === '') return { status: 'no-key' };
    const listed = alphaVantageSymbol(symbol);
    if (listed === null) return { status: 'not-listed' };
    try {
      await quota.consume(1);
    } catch {
      return { status: 'quota' };
    }
    try {
      await this.options.pace?.();
      const url = `${ALPHAVANTAGE_URL}?function=EARNINGS&symbol=${encodeURIComponent(listed)}&apikey=${encodeURIComponent(apiKey)}`;
      const response = await this.options.fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return { status: 'error' };
      const json: unknown = await response.json();
      // Throttling and quota notes come back as HTTP 200 with an `Information` or `Note` field.
      if (isRecord(json) && ('Information' in json || 'Note' in json || 'Error Message' in json)) return { status: 'quota' };
      const estimate = pickEstimate(json, reportDate);
      return estimate === undefined ? { status: 'no-entry' } : { status: 'ok', estimate };
    } catch (error) {
      if (error instanceof Error && error.name.startsWith('Subrequest')) throw error;
      return { status: 'error' };
    }
  }
}
