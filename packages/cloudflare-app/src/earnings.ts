/**
 * Wiring of the earnings summaries (`@portfolio/earnings`) to the Hub: the held companies and the calendar read through the same
 * repositories the API uses, the Workers AI allowance read from the budget guard, and the job dependencies of one alarm run. No business
 * logic: the feature itself is platform-neutral.
 */
import type { BudgetGuard, ItemStore, JobQueue } from '@portfolio/platform';
import { ItemManagementRepository, ItemNotificationRepository, ItemRepository, type EarningsDeps } from '@portfolio/api';
import {
  AlphaVantageEstimates,
  EarningsRepository,
  EarningsService,
  SecClient,
  WorkersAiExtractor,
  addDays,
  type AiLike,
  type EarningsInputs,
  type EarningsJobDeps,
  type NeuronMeter,
  type NeuronsToday,
} from '@portfolio/earnings';
import { DailyQuota, StoreQuotaLedger } from '@portfolio/prices';
import { heldQuantities, isMarketSymbol, kpiTemplateFor, type EarningsHolding } from '@portfolio/shared';
import type { HubConfig } from './config.js';

/** Whether the feature has everything it needs: the SEC contact and the Workers AI binding. */
export const earningsConfigured = (config: HubConfig, ai: AiLike | undefined): boolean => config.earnings.secUserAgent !== undefined && ai !== undefined;

/** Calendar dates are looked at from a week back (a release the day before the expected date) to a few months ahead (so a symbol with a date is not probed daily). */
const CALENDAR_DAYS_BACK = 7;
const CALENDAR_DAYS_AHEAD = 130;

/**
 * The distinct companies held by any user today, with the KPI template (the owner's override, else the table or sector) and the expected
 * report dates of the calendar. Instruments without earnings (ETFs, crypto, ...) are left out. A user whose transactions cannot be replayed
 * (an oversold position) is skipped. Nothing about quantities or users leaves this function.
 */
export function createEarningsInputs(items: ItemStore): EarningsInputs {
  const repo = new ItemRepository(items);
  const mgmt = new ItemManagementRepository(items);
  const users = new ItemNotificationRepository(items);
  return {
    async build(today) {
      const userIds = await users.listUserIds();
      const held = await Promise.all(
        userIds.map(async (userId) => {
          try {
            return { userId, symbols: [...heldQuantities(await repo.listTransactions(userId), today).keys()].filter(isMarketSymbol) };
          } catch {
            return { userId, symbols: [] as string[] };
          }
        }),
      );
      const symbols = [...new Set(held.flatMap((entry) => entry.symbols))].sort((a, b) => a.localeCompare(b));
      if (symbols.length === 0) return { holdings: [], calendar: {} };
      const [profiles, overrides] = await Promise.all([repo.getProfiles(symbols), Promise.all(held.map((entry) => mgmt.getClassificationOverrides(entry.userId, entry.symbols)))]);
      const override = (symbol: string): string | undefined => overrides.map((byUser) => byUser[symbol]?.kpiTemplate).find((template) => template !== undefined);
      const holdings: EarningsHolding[] = [];
      for (const symbol of symbols) {
        const profile = profiles[symbol];
        const template = kpiTemplateFor({ symbol, assetClass: profile?.assetClass, sector: profile?.sector, override: override(symbol) });
        if (template !== null) holdings.push({ symbol, name: profile?.name ?? symbol, template, ...(profile?.currency === undefined ? {} : { currency: profile.currency }) });
      }
      const wanted = holdings.map((holding) => holding.symbol);
      const events = wanted.length === 0 ? { earnings: [] } : await repo.getCalendarEvents(wanted, addDays(today, -CALENDAR_DAYS_BACK), addDays(today, CALENDAR_DAYS_AHEAD));
      const calendar: Record<string, string[]> = {};
      for (const event of events.earnings) {
        const dates = calendar[event.symbol] ?? [];
        dates.push(event.date);
        calendar[event.symbol] = dates;
      }
      return { holdings, calendar };
    },
  };
}

/** The Workers AI allowance seen by the extractor: the daily cap of the feature (at most 80 % of the Free allowance), minus what the guard counted. */
export function neuronMeter(guard: BudgetGuard, dailyCap: number): NeuronMeter {
  return {
    async remaining() {
      const allowance = await guard.aiAllowance();
      if (allowance.state === 'blocked' || allowance.state === 'unavailable') return 0;
      return Math.max(0, Math.min(dailyCap, allowance.limit * 0.8) - allowance.used);
    },
    spend: (neurons) => guard.record({ aiNeurons: neurons }),
  };
}

export interface EarningsContext {
  items: ItemStore;
  queue: JobQueue;
  now: () => Date;
  config: HubConfig;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  ai?: AiLike;
  neurons: NeuronMeter;
}

/** What `watchEarnings` and `fetchEarningsSummary` need for one alarm run; every outbound call goes through the alarm's counted `fetch`. */
export function earningsJobDeps(context: EarningsContext): EarningsJobDeps {
  const { items, config, now } = context;
  const { earnings } = config;
  const fetchFn = (url: string, init?: RequestInit): Promise<Response> => context.fetch(url, init);
  const today = (): string => now().toISOString().slice(0, 10);
  return {
    repo: new EarningsRepository(items),
    inputs: createEarningsInputs(items),
    config: earnings,
    ...(earnings.secUserAgent === undefined ? {} : { sec: new SecClient({ userAgent: earnings.secUserAgent, fetch: fetchFn, now, sleep: context.sleep }) }),
    ...(context.ai === undefined ? {} : { extractor: new WorkersAiExtractor({ ai: context.ai, meter: context.neurons, model: earnings.model }) }),
    estimates: new AlphaVantageEstimates({ apiKey: config.prices.keys.alphavantage, fetch: fetchFn, quota: new DailyQuota(new StoreQuotaLedger(items), 'alphavantage', config.prices.dailyLimits.alphavantage, today) }),
    queue: context.queue,
    now,
  };
}

/** The API's view of the feature (`Deps.earnings`). */
export function createEarningsApi(options: { items: ItemStore; config: HubConfig; ai?: AiLike; queue: JobQueue; now: () => Date; guard: BudgetGuard }): EarningsDeps {
  const { guard } = options;
  const neurons = async (): Promise<NeuronsToday> => {
    const allowance = await guard.aiAllowance();
    return { used: allowance.used, allowance: allowance.limit, state: allowance.state, resetsAt: allowance.resetsAt };
  };
  return new EarningsService({ repo: new EarningsRepository(options.items), config: options.config.earnings, aiBound: options.ai !== undefined, queue: options.queue, now: options.now, neurons });
}
