/**
 * The Cloudflare side of Diagnostics > "Test Alpha Vantage now" (`Deps.alphaVantageProbe`): one real `EARNINGS_ESTIMATES` call for a fixed US ticker with the
 * real key, and what Alpha Vantage said, sanitised, so the owner sees which limit the key hits. No business logic beyond mapping the client's answer to
 * the words of the screen: the classification lives in `@portfolio/prices` (`parseEarningsEstimates`).
 *
 * It costs one of the provider's calls of the UTC day (the shared `USAGE/alphavantage` counter), runs at most once per 10 minutes and is refused when
 * fewer than 3 calls are left by that counter.
 */
import { nextUtcMidnight, utcDay, type ItemStore } from '@portfolio/platform';
import type { AlphaVantageProbeDeps } from '@portfolio/api';
import { AlphaVantageEstimatesClient, PriceRepository, StoreQuotaLedger, type EstimateLimit, type EstimatesAnswer, type PricesConfig, type ProviderPacer } from '@portfolio/prices';
import {
  PROBE_INTERVAL_SECONDS,
  PROBE_MIN_CALLS,
  PROBE_SYMBOL,
  probeSummary,
  type AlphaVantageProbeResult,
  type AlphaVantageProbeStatus,
  type ProbeOutcome,
  type ProbeRefusal,
  type ProviderBudgetReport,
} from '@portfolio/shared';

/** The last probe: when it ran and what it found (one item). */
export const PROBE_KEY = { PK: 'DIAGNOSTICS', SK: 'ALPHAVANTAGE#PROBE' } as const;
const PROBE_ENTITY = 'ALPHAVANTAGE_PROBE';
const USAGE_KEY = { PK: 'USAGE', SK: 'alphavantage' } as const;
const USAGE_ENTITY = 'PROVIDER_USAGE';

export interface AlphaVantageProbeContext {
  items: ItemStore;
  config: PricesConfig;
  now: () => Date;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  pacer: Pick<ProviderPacer, 'wait'>;
}

type Refusal = { accepted: false; reason: ProbeRefusal; message: string; retryAfterSeconds?: number };
type Blocked = { refusal: Refusal; nextAllowedAt: string | null };

interface LastProbe {
  /** When the last probe was asked (its result is absent while the call is out). */
  at: string;
  result: AlphaVantageProbeResult | null;
}

interface ProbeState {
  budget: ProviderBudgetReport;
  last: LastProbe | null;
  blocked: Blocked | null;
}

const clock = (iso: string): string => iso.slice(11, 16);

const LIMIT_OUTCOME: Readonly<Record<EstimateLimit, ProbeOutcome>> = { daily: 'daily-limit', burst: 'burst-limit', other: 'rate-limited' };

/** The words of an answer: the outcome of the screen, the provider's sanitised text and the number of quarters. */
export function resultOf(answer: EstimatesAnswer, at: string): AlphaVantageProbeResult {
  const base = { at, symbol: PROBE_SYMBOL, call: 'EARNINGS_ESTIMATES' } as const;
  const make = (outcome: ProbeOutcome, message?: string, quarters?: number): AlphaVantageProbeResult => ({
    ...base,
    outcome,
    summary: probeSummary(outcome, quarters),
    ...(message === undefined ? {} : { message }),
    ...(quarters === undefined ? {} : { quarters }),
  });
  switch (answer.status) {
    case 'ok':
      return make('ok', undefined, answer.quarters.length);
    case 'premium':
      return make('premium', answer.detail);
    case 'rate-limited':
      return make(LIMIT_OUTCOME[answer.scope ?? 'other'], answer.detail);
    case 'no-coverage':
      return make('no-coverage');
    default:
      return make(answer.invalidKey === true ? 'invalid-key' : 'error', answer.reason);
  }
}

/** The Cloudflare adapter of the Alpha Vantage test. */
export function createAlphaVantageProbeApi({ items, config, now, fetch, pacer }: Readonly<AlphaVantageProbeContext>): AlphaVantageProbeDeps {
  const prices = new PriceRepository(items);
  const ledger = new StoreQuotaLedger(items);
  const apiKey = config.keys.alphavantage;

  async function lastProbe(): Promise<LastProbe | null> {
    const item = await items.get(PROBE_KEY);
    if (item === undefined || typeof item.askedAt !== 'string') return null;
    return { at: item.askedAt, result: item.result === undefined ? null : (item.result as AlphaVantageProbeResult) };
  }

  async function budgetOf(day: string): Promise<ProviderBudgetReport> {
    const limit = config.dailyLimits.alphavantage;
    const { used, calendarUsed } = await prices.callsUsedOn('alphavantage', day);
    return { provider: 'Alpha Vantage', day, used, limit, remaining: Math.max(0, limit - used), calendarUsed, calendarLimit: config.calendar.alphavantageDailyCalls };
  }

  /** Why the test may not run now (null when it may), with when it may next. */
  async function refusalOf(budget: ProviderBudgetReport, asked: string | undefined): Promise<Blocked | null> {
    const at = now();
    if (apiKey === undefined) {
      return { refusal: { accepted: false, reason: 'not-configured', message: 'No Alpha Vantage key is set on this deployment (the ALPHAVANTAGE_API_KEY secret), so there is nothing to test.' }, nextAllowedAt: null };
    }
    const waitMs = asked === undefined ? 0 : Date.parse(asked) + PROBE_INTERVAL_SECONDS * 1000 - at.getTime();
    if (waitMs > 0) {
      const retryAt = new Date(at.getTime() + waitMs).toISOString();
      const message = `The test ran at ${clock(asked!)} UTC; you can run it again after ${clock(retryAt)} UTC (once every 10 minutes).`;
      return { refusal: { accepted: false, reason: 'rate-limited', message, retryAfterSeconds: Math.ceil(waitMs / 1000) }, nextAllowedAt: retryAt };
    }
    if (budget.remaining < PROBE_MIN_CALLS) {
      const resets = nextUtcMidnight(at);
      const message = `Alpha Vantage allowance nearly used: ${budget.used} of ${budget.limit} calls today (UTC). The test needs ${PROBE_MIN_CALLS} left; it resets at 00:00 UTC.`;
      return { refusal: { accepted: false, reason: 'budget-low', message, retryAfterSeconds: Math.ceil((resets.getTime() - at.getTime()) / 1000) }, nextAllowedAt: resets.toISOString() };
    }
    return null;
  }

  async function state(): Promise<ProbeState> {
    const [budget, last] = await Promise.all([budgetOf(utcDay(now())), lastProbe()]);
    return { budget, last, blocked: await refusalOf(budget, last?.at) };
  }

  return {
    async status(): Promise<AlphaVantageProbeStatus> {
      const { budget, last, blocked } = await state();
      return { available: blocked === null, reason: blocked?.refusal.message ?? null, nextAllowedAt: blocked?.nextAllowedAt ?? null, budget, last: last?.result ?? null };
    },
    async run() {
      const { budget, last, blocked } = await state();
      if (blocked !== null) return blocked.refusal;
      const at = now();
      const day = utcDay(at);
      // The call is counted before it is made, and the ask is recorded first so a second click while the call is out is refused: a refusal by the provider still used one of its calls.
      if (!(await ledger.consume(USAGE_KEY, USAGE_ENTITY, day, 1, config.dailyLimits.alphavantage))) {
        return { accepted: false, reason: 'budget-low', message: `Alpha Vantage allowance used up: ${budget.used} of ${budget.limit} calls today (UTC).` };
      }
      await items.put({ ...PROBE_KEY, entityType: PROBE_ENTITY, askedAt: at.toISOString(), ...(last?.result ? { result: last.result } : {}) });
      const client = new AlphaVantageEstimatesClient({ apiKey: apiKey!, fetch, pace: () => pacer.wait('alphavantage') });
      const result = resultOf(await client.fetchEstimates(PROBE_SYMBOL), at.toISOString());
      await items.put({ ...PROBE_KEY, entityType: PROBE_ENTITY, askedAt: result.at, result });
      return { accepted: true, result: { ...result, budget: await budgetOf(day) } };
    },
  };
}
