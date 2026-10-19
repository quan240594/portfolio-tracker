import { sequentially } from '@portfolio/shared';
import { ProviderError, SymbolNotFoundError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { asFloat, byText, isRecord } from '../parse.js';
import { addDays, isWeekday, zonedTimeToUtc } from '../time.js';
import type { FxDay } from '@portfolio/shared';
import type { FxLatest, FxSource } from './base.js';

/**
 * Frankfurter (ECB reference rates), no API key:
 * - latest: `GET /v1/latest?base=EUR` gives `{base, date, rates: {CUR: rate}}`
 * - series: `GET /v1/{start}..{end}?base=EUR` gives `{base, rates: {YYYY-MM-DD: {CUR: rate}}}` for ECB business days only.
 */
export const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1';

/** The ECB publishes its reference rates around 16:00 Frankfurt time. */
const ecbPublication = (day: string): Date => zonedTimeToUtc(day, 16, 'Europe/Berlin');

function parseRates(raw: unknown, base: string): Record<string, number> {
  if (!isRecord(raw)) return {};
  const rates: Record<string, number> = {};
  for (const [code, value] of Object.entries(raw)) {
    const rate = asFloat(value);
    const currency = code.toUpperCase();
    if (rate !== null && rate > 0 && currency !== base) rates[currency] = rate;
  }
  return rates;
}

/** Splits [start, end] into ranges that never cross a calendar-year boundary. */
export function yearChunks(start: string, end: string): [string, string][] {
  const out: [string, string][] = [];
  let lo = start;
  while (lo <= end) {
    const yearEnd = `${lo.slice(0, 4)}-12-31`;
    const hi = yearEnd < end ? yearEnd : end;
    out.push([lo, hi]);
    lo = addDays(hi, 1);
  }
  return out;
}

/** Whether the range has a weekday among its first seven days (a weekend-only range has no ECB fixing). */
export function hasWeekday(start: string, end: string): boolean {
  const span = Math.min(Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1, 7);
  return Array.from({ length: span }, (_, i) => addDays(start, i)).some(isWeekday);
}

export interface FrankfurterOptions {
  http: HttpClient;
  now: () => Date;
}

export class FrankfurterFx implements FxSource {
  readonly name = 'frankfurter';

  constructor(private readonly options: FrankfurterOptions) {}

  async getLatest(base: string): Promise<FxLatest> {
    const raw = await this.options.http.getJson(`${FRANKFURTER_URL}/latest`, { base });
    const data = isRecord(raw) ? raw : {};
    const resolved = String(data.base || base).toUpperCase();
    const rates = parseRates(data.rates, resolved);
    if (Object.keys(rates).length === 0) throw new ProviderError(`${this.name}: empty rates for base ${base}`, { provider: this.name });
    const day = data.date ? String(data.date) : undefined;
    const asOf = day === undefined ? this.options.now() : ecbPublication(day);
    return day === undefined ? { base: resolved, rates, asOf: asOf.toISOString() } : { base: resolved, rates, asOf: asOf.toISOString(), date: day };
  }

  /** The fixings of one year-bounded range; empty when the provider has none. One HTTP request. */
  async getHistoryChunk(base: string, lo: string, hi: string): Promise<FxDay[]> {
    const currency = base.toUpperCase();
    let data: unknown;
    try {
      data = await this.options.http.getJson(`${FRANKFURTER_URL}/${lo}..${hi}`, { base: currency });
    } catch (error) {
      // A range without any fixing (only TARGET holidays) is a 404.
      if (error instanceof SymbolNotFoundError) return [];
      throw error;
    }
    return this.parseSeries(data, currency, lo, hi);
  }

  private parseSeries(data: unknown, currency: string, lo: string, hi: string): FxDay[] {
    if (!isRecord(data)) throw new ProviderError(`${this.name}: malformed time series ${lo}..${hi}`, { provider: this.name });
    if (String(data.base || currency).toUpperCase() !== currency) throw new ProviderError(`${this.name}: unexpected base ${JSON.stringify(data.base)}`, { provider: this.name });
    const series = data.rates ?? {};
    if (!isRecord(series)) throw new ProviderError(`${this.name}: malformed time series ${lo}..${hi}`, { provider: this.name });
    const days: FxDay[] = [];
    for (const [day, raw] of Object.entries(series)) {
      // Frankfurter snaps a non-business start date back to the previous fixing; drop it.
      if (day < lo || day > hi) continue;
      const rates = parseRates(raw, currency);
      if (Object.keys(rates).length > 0) days.push({ base: currency, date: day, rates });
    }
    return days.toSorted((a, b) => byText(a.date, b.date));
  }

  /** Daily fixings for the ECB business days in [start, end], ascending, one request per calendar year. */
  async getHistory(base: string, start: string, end: string): Promise<FxDay[]> {
    const byDate = new Map<string, FxDay>();
    const ranges = yearChunks(start, end).filter(([lo, hi]) => hasWeekday(lo, hi));
    for await (const days of sequentially(ranges, ([lo, hi]) => this.getHistoryChunk(base, lo, hi))) for (const day of days) byDate.set(day.date, day);
    return [...byDate.keys()].toSorted(byText).map((date) => byDate.get(date)!);
  }
}
