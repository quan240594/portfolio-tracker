/**
 * Configuration of the price jobs. It is parsed from an injected environment (a Worker's `env`, `process.env`, a test
 * object): this package reads no global. API keys come from that environment and are never logged or stored.
 */
export type Env = Readonly<Record<string, string | undefined>>;

export const EARNINGS_HORIZONS = ['3month', '6month', '12month'] as const;
export type EarningsHorizon = (typeof EARNINGS_HORIZONS)[number];

export interface ApiKeys {
  twelvedata?: string;
  eodhd?: string;
  coingecko?: string;
  alphavantage?: string;
}

export interface CalendarSettings {
  earningsHorizon: EarningsHorizon;
  /** Alpha Vantage calls a day for the earnings calendar (one call serves every tracked ticker). */
  alphavantageDailyCalls: number;
  /** EODHD calls a day for splits and dividends (of the free plan's 20, shared with the quote refresh and enrichment). */
  eodhdDailyCalls: number;
  recheckDays: number;
  refreshDividends: boolean;
  splitLookbackDays: number;
}

export interface PricesConfig {
  baseCurrency: string;
  /** First day of the initial FX_DAY backfill (only used while no FX_DAY item exists). */
  fxHistoryStart: string;
  /** Europe/Amsterdam hours in which exchange-suffixed symbols are refreshed. */
  euRefreshHours: readonly number[];
  keys: ApiKeys;
  /** Extra `TICKER=coingecko-id` pairs. */
  coinGeckoCoinIds: string;
  /** Free-tier daily budgets, spent through the persisted quota ledger. */
  dailyLimits: { twelvedata: number; eodhd: number; alphavantage: number };
  calendar: CalendarSettings;
}

export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  earningsHorizon: '12month',
  alphavantageDailyCalls: 1,
  eodhdDailyCalls: 8,
  recheckDays: 7,
  refreshDividends: true,
  splitLookbackDays: 90,
};

const DEFAULT_FX_HISTORY_START = '2015-01-01';

function intFrom(raw: string | undefined, fallback: number, minimum = 0): number {
  const text = (raw ?? '').trim();
  if (!/^[+-]?\d+$/.test(text)) return fallback;
  return Math.max(minimum, Number.parseInt(text, 10));
}

function boolFrom(raw: string | undefined, fallback: boolean): boolean {
  const text = (raw ?? '').trim().toLowerCase();
  if (text === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(text);
}

const keyFrom = (raw: string | undefined): string | undefined => (raw?.trim() ? raw.trim() : undefined);

function hoursFrom(raw: string | undefined): number[] {
  const hours: number[] = [];
  for (const part of (raw ?? '18').split(',')) {
    const text = part.trim();
    if (/^\d{1,2}$/.test(text) && Number(text) < 24) hours.push(Number(text));
  }
  return hours.length > 0 ? hours : [18];
}

function dateFrom(raw: string | undefined, fallback: string): string {
  const text = (raw ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? text : fallback;
}

export function parseCalendarSettings(env: Env): CalendarSettings {
  const horizon = (env.CALENDAR_EARNINGS_HORIZON ?? '').trim().toLowerCase();
  return {
    earningsHorizon: EARNINGS_HORIZONS.find((h) => h === horizon) ?? DEFAULT_CALENDAR_SETTINGS.earningsHorizon,
    alphavantageDailyCalls: intFrom(env.CALENDAR_ALPHAVANTAGE_DAILY_CALLS, DEFAULT_CALENDAR_SETTINGS.alphavantageDailyCalls),
    eodhdDailyCalls: intFrom(env.CALENDAR_EODHD_DAILY_CALLS, DEFAULT_CALENDAR_SETTINGS.eodhdDailyCalls),
    recheckDays: intFrom(env.CALENDAR_RECHECK_DAYS, DEFAULT_CALENDAR_SETTINGS.recheckDays, 1),
    refreshDividends: boolFrom(env.CALENDAR_REFRESH_DIVIDENDS, DEFAULT_CALENDAR_SETTINGS.refreshDividends),
    splitLookbackDays: intFrom(env.CALENDAR_SPLIT_LOOKBACK_DAYS, DEFAULT_CALENDAR_SETTINGS.splitLookbackDays),
  };
}

/**
 * Alpha Vantage calls the profile lookups and the EPS estimates may use of the shared daily limit: the calendar keeps its own call(s), so
 * a day of enrichment (about one profile call per US holding) can never leave it without its one cheap call.
 */
export const alphaVantageGeneralLimit = (config: Pick<PricesConfig, 'dailyLimits' | 'calendar'>): number => Math.max(0, config.dailyLimits.alphavantage - config.calendar.alphavantageDailyCalls);

/** The environment variables are those of the Python service (`services/prices/README.md`), minus the AWS-only ones. */
export function parsePricesConfig(env: Env): PricesConfig {
  return {
    baseCurrency: (env.BASE_CURRENCY ?? '').trim().toUpperCase() || 'EUR',
    fxHistoryStart: dateFrom(env.FX_HISTORY_START, DEFAULT_FX_HISTORY_START),
    euRefreshHours: hoursFrom(env.EU_REFRESH_HOURS),
    keys: {
      twelvedata: keyFrom(env.TWELVEDATA_API_KEY),
      eodhd: keyFrom(env.EODHD_API_KEY),
      coingecko: keyFrom(env.COINGECKO_API_KEY),
      alphavantage: keyFrom(env.ALPHAVANTAGE_API_KEY),
    },
    coinGeckoCoinIds: env.COINGECKO_COIN_IDS ?? '',
    dailyLimits: { twelvedata: 800, eodhd: intFrom(env.EODHD_DAILY_LIMIT, 20), alphavantage: intFrom(env.ALPHAVANTAGE_DAILY_LIMIT, 25) },
    calendar: parseCalendarSettings(env),
  };
}
