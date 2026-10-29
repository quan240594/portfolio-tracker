/**
 * Earnings summaries: contracts shared by the extraction pipeline (`@portfolio/earnings`), the API, the notification job and the web app.
 *
 * A summary is derived from a company's own public quarterly press release (SEC 8-K item 2.02 / 6-K exhibit). The release text is the only
 * source of the figures; every number was located verbatim in that text, all derived numbers (growth, beat or miss, free cash flow) are
 * computed by code. Nothing is invented: a value that is not in the release is absent.
 *
 * | Entity                 | PK               | SK                      | entityType         |
 * |------------------------|------------------|-------------------------|--------------------|
 * | Summary (one release)  | TICKER#{symbol}  | EARNSUM#{reportDate}    | EARNINGS_SUMMARY   |
 * | Per-symbol watch state | TICKER#{symbol}  | EARNSTATE               | EARNINGS_STATE     |
 * | SEC block (global)     | EARNINGS         | SEC                     | EARNINGS_SEC       |
 * | Held-symbol cache      | EARNINGS         | HELD                    | EARNINGS_HELD      |
 *
 * The release is public and the same for every user, so summaries live next to the other per-symbol data (`TICKER#`), not under a user.
 * `EARNSUM#` does not start with the calendar's `EARN#`, so the two prefixes never meet.
 *
 * Routes (authenticated, same-origin; `available: false` on a deployment without the feature, e.g. the AWS demo):
 * - GET  /earnings?symbol=&limit=      latest summaries, newest first, only for symbols the user holds now
 * - GET  /earnings/status              is the feature configured, per-symbol checks, neurons used today
 * - GET  /earnings/{symbol}/{period}   one summary (`period` = the report date, YYYY-MM-DD)
 * - POST /earnings/{symbol}/refresh    owner-triggered re-check, at most once per symbol per hour
 * - POST /earnings/backfill            owner-triggered "fetch all now" (rescan all): re-derives the current holdings, drops the check state of sold ones, starts the backfill of every holding over, at most once per hour
 */
import { z } from 'zod';
import type { ConsensusEndpoint, ConsensusOutcome, SummaryConsensus } from './earnings-consensus.js';

export const EARNINGS_ROUTES = {
  earningsList: 'GET /earnings',
  earningsStatus: 'GET /earnings/status',
  earningsGet: 'GET /earnings/{symbol}/{period}',
  earningsRefresh: 'POST /earnings/{symbol}/refresh',
  earningsBackfill: 'POST /earnings/backfill',
} as const;

export const EARNINGS_ENTITY = { summary: 'EARNINGS_SUMMARY', state: 'EARNINGS_STATE', sec: 'EARNINGS_SEC', held: 'EARNINGS_HELD', backfill: 'EARNINGS_BACKFILL' } as const;

export const earningsKeys = {
  summary: (symbol: string, reportDate: string) => ({ PK: `TICKER#${symbol}`, SK: `EARNSUM#${reportDate}` }),
  summaryPrefix: 'EARNSUM#',
  state: (symbol: string) => ({ PK: `TICKER#${symbol}`, SK: 'EARNSTATE' }),
  tickerPk: (symbol: string) => `TICKER#${symbol}`,
  sec: { PK: 'EARNINGS', SK: 'SEC' },
  held: { PK: 'EARNINGS', SK: 'HELD' },
  backfill: { PK: 'EARNINGS', SK: 'BACKFILL' },
} as const;

/** The newest quarters kept per symbol. */
export const EARNINGS_KEEP_QUARTERS = 8;
/** 2: summaries carry the `dividend` and `buyback` blocks. A stored summary with a lower version is re-read (only those two blocks) by the backfill. */
export const EARNINGS_SCHEMA_VERSION = 2;
/** Responses carry at most this many summaries. */
export const EARNINGS_MAX_LIMIT = 24;
export const EARNINGS_DEFAULT_LIMIT = 12;
/** A summary older than this many days is never announced by a push (it is recorded silently). */
export const EARNINGS_FRESH_DAYS = 5;
/** `POST /earnings/{symbol}/refresh` is accepted once per symbol per this many milliseconds. */
export const EARNINGS_REFRESH_INTERVAL_MS = 3_600_000;
/** Quarterly releases the backfill reads per holding (`EARNINGS_BACKFILL_QUARTERS`): the default and the most. */
export const EARNINGS_BACKFILL_DEFAULT_QUARTERS = 4;
export const EARNINGS_BACKFILL_MAX_QUARTERS = 8;
/** A release published this recently is announced even when the backfill found it. */
export const EARNINGS_LIVE_HOURS = 48;

export const EARNINGS_DISCLAIMER = "Auto-generated from the company's press release; every number was checked against the text. Check the source before acting.";

// --- Templates -----------------------------------------------------------------------------------------------------------

export const KPI_TEMPLATE_IDS = ['generic', 'reit', 'bank', 'saas', 'infra'] as const;
export type KpiTemplateId = (typeof KPI_TEMPLATE_IDS)[number];

export const KPI_TEMPLATE_LABELS: Readonly<Record<KpiTemplateId, string>> = {
  generic: 'General company',
  reit: 'REIT (real estate)',
  bank: 'Bank',
  saas: 'Software as a service',
  infra: 'Tech infrastructure and cloud',
};

export const METRIC_UNITS = ['money', 'perShare', 'percent', 'count', 'ratio'] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/** The figures every template can carry (extracted or computed); `dilutedShares` only feeds the per-share free cash flow. */
export const CORE_METRIC_KEYS = ['eps', 'revenue', 'operatingIncome', 'operatingMargin', 'netIncome', 'operatingCashFlow', 'capex', 'fcf', 'fcfPerShare', 'dilutedShares'] as const;
export type CoreMetricKey = (typeof CORE_METRIC_KEYS)[number];

export const CORE_METRIC_META: Readonly<Record<CoreMetricKey, { label: string; unit: MetricUnit }>> = {
  eps: { label: 'EPS', unit: 'perShare' },
  revenue: { label: 'Revenue', unit: 'money' },
  operatingIncome: { label: 'Operating profit', unit: 'money' },
  operatingMargin: { label: 'Operating margin', unit: 'percent' },
  netIncome: { label: 'Net income', unit: 'money' },
  operatingCashFlow: { label: 'Cash from operations', unit: 'money' },
  capex: { label: 'Capital expenditure', unit: 'money' },
  fcf: { label: 'Free cash flow', unit: 'money' },
  fcfPerShare: { label: 'FCF per share', unit: 'perShare' },
  dilutedShares: { label: 'Diluted shares', unit: 'count' },
};

export interface KpiSlot {
  key: string;
  label: string;
  unit: MetricUnit;
  /** What the extraction asks for (shown to the model: the value exactly as printed in the release). */
  hint: string;
}

export interface KpiTemplate {
  id: KpiTemplateId;
  label: string;
  /** The two scorecard rows (keys of the headline metrics or of `slots`): the per-share result and revenue. */
  scorecard: readonly string[];
  /** Whether the template shows free cash flow (banks and REITs do not). */
  showFcf: boolean;
  /** Template specific figures, in display order. A slot the release does not state is shown as "not disclosed". */
  slots: readonly KpiSlot[];
}

const slot = (key: string, label: string, unit: MetricUnit, hint: string): KpiSlot => ({ key, label, unit, hint });

export const KPI_TEMPLATES: Readonly<Record<KpiTemplateId, KpiTemplate>> = {
  generic: { id: 'generic', label: KPI_TEMPLATE_LABELS.generic, scorecard: ['eps', 'revenue'], showFcf: true, slots: [] },
  reit: {
    id: 'reit',
    label: KPI_TEMPLATE_LABELS.reit,
    scorecard: ['affoPerShare', 'revenue'],
    showFcf: false,
    slots: [
      slot('affoPerShare', 'AFFO per share', 'perShare', 'Adjusted funds from operations (AFFO) per diluted share'),
      slot('ffoPerShare', 'FFO per share', 'perShare', 'Funds from operations (FFO or Nareit FFO) per diluted share'),
      slot('occupancy', 'Occupancy', 'percent', 'Portfolio occupancy or leased percentage'),
      slot('sameStoreNoi', 'Same-store NOI growth', 'percent', 'Same-store (same-property) net operating income growth'),
    ],
  },
  bank: {
    id: 'bank',
    label: KPI_TEMPLATE_LABELS.bank,
    scorecard: ['eps', 'revenue'],
    showFcf: false,
    slots: [
      slot('rotce', 'ROTCE', 'percent', 'Return on tangible common equity (ROTCE)'),
      slot('tbvps', 'Tangible book value per share', 'perShare', 'Tangible book value per common share (TBVPS)'),
      slot('cet1', 'CET1 capital ratio', 'percent', 'Common equity tier 1 (CET1) capital ratio'),
      slot('netInterestIncome', 'Net interest income', 'money', 'Net interest income (NII)'),
      slot('efficiencyRatio', 'Efficiency ratio', 'percent', 'Efficiency ratio'),
      slot('provisionForCreditLosses', 'Provision for credit losses', 'money', 'Provision for credit losses'),
    ],
  },
  saas: {
    id: 'saas',
    label: KPI_TEMPLATE_LABELS.saas,
    scorecard: ['eps', 'revenue'],
    showFcf: true,
    slots: [
      slot('rpo', 'Remaining performance obligations', 'money', 'Remaining performance obligations (RPO) or backlog in currency'),
      slot('crpo', 'Current RPO growth', 'percent', 'Current remaining performance obligations (cRPO) growth, as a percentage'),
      slot('arr', 'Annual recurring revenue', 'money', 'Annual recurring revenue (ARR) in currency'),
      slot('nrr', 'Net revenue retention', 'percent', 'Net revenue retention or dollar-based net expansion rate'),
      slot('seats', 'Seats or subscribers growth', 'percent', 'Growth in seats, subscribers or paid customers, as a percentage'),
    ],
  },
  infra: {
    id: 'infra',
    label: KPI_TEMPLATE_LABELS.infra,
    scorecard: ['eps', 'revenue'],
    showFcf: true,
    slots: [
      slot('rpo', 'RPO, committed revenue or backlog', 'money', 'Remaining performance obligations, committed revenue, backlog or bookings in currency'),
      slot('cloudRevenue', 'Cloud revenue', 'money', 'Cloud (or data center, or infrastructure) segment revenue in currency'),
      slot('cloudGrowth', 'Cloud revenue growth', 'percent', 'Growth of cloud (or data center) revenue, as a percentage'),
      slot('capexKpi', 'Capital expenditure', 'money', 'Capital expenditures (purchases of property and equipment) in currency'),
    ],
  },
};

export const isKpiTemplateId = (value: unknown): value is KpiTemplateId => typeof value === 'string' && (KPI_TEMPLATE_IDS as readonly string[]).includes(value);

// --- Stored shapes -------------------------------------------------------------------------------------------------------

export type EarningsBasis = 'GAAP' | 'adjusted' | 'reported' | 'calculated';
export type EarningsVerdict = 'beat' | 'miss' | 'inline';

/** One verified figure. Money is in whole currency units, percentages in percent points, shares as counts. */
export interface EarningsMetric {
  value: number;
  unit: MetricUnit;
  /** The figure as printed in the release (with its unit), for display next to the source. */
  raw?: string;
  /** The same figure a year earlier, as printed in the same release. */
  yearAgo?: number;
  /** Year over year, computed from `yearAgo` (percent change; absent when `yearAgo` is zero or negative). */
  yoyPct?: number;
  /** Year over year in percentage points, for metrics that are themselves percentages. */
  yoyPoints?: number;
  /** Quarter over quarter against the previously stored summary of the symbol (same basis and currency only). */
  qoqPct?: number;
  qoqPoints?: number;
  /** Consensus estimate (EPS only, from Alpha Vantage when a key is configured). */
  estimate?: number;
  surprisePct?: number;
  verdict?: EarningsVerdict;
  basis?: EarningsBasis;
}

export interface EarningsKpi {
  key: string;
  label: string;
  unit: MetricUnit;
  /** Absent when the release does not state the figure ("not disclosed"). */
  metric?: EarningsMetric;
}

export type GuidanceDirection = 'raised' | 'lowered' | 'maintained' | 'new';

export interface EarningsGuidance {
  label: string;
  /** For example "full year 2026". */
  period?: string;
  unit: MetricUnit;
  low?: number;
  high?: number;
  /** A single figure instead of a range. */
  point?: number;
  raw: string;
  /** Against the guidance with the same label in the previous stored summary (code-computed). */
  direction?: GuidanceDirection;
}

export interface EarningsSegment {
  name: string;
  value: number;
  raw?: string;
  yearAgo?: number;
  yoyPct?: number;
}

export interface EarningsQuote {
  text: string;
  speaker?: string;
}

/** `announced`: the release states it; `none`: it states none (shown as N/A); `not-found`: the release mentions one but it could not be read and verified reliably. */
export type CapitalReturnStatus = 'announced' | 'none' | 'not-found';

export const DIVIDEND_ACTIONS = ['raised', 'cut', 'maintained', 'initiated', 'suspended'] as const;
export type DividendAction = (typeof DIVIDEND_ACTIONS)[number];
export const DIVIDEND_FREQUENCIES = ['monthly', 'quarterly', 'semi-annual', 'annual', 'special'] as const;
export type DividendFrequency = (typeof DIVIDEND_FREQUENCIES)[number];

/** The dividend announced with the results. Every amount was found in the release; raised or cut is computed from two printed amounts when there are two. */
export interface EarningsDividend {
  status: CapitalReturnStatus;
  /** Declared amount per share, in `currency`. */
  perShare?: number;
  raw?: string;
  currency?: string;
  action?: DividendAction;
  /** `computed`: from `perShare` and `previousPerShare`; `stated`: the release itself says increased, reduced and so on. */
  actionSource?: 'computed' | 'stated';
  previousPerShare?: number;
  /** `release`: printed in the same release; `stored`: the amount of the previous stored summary of the symbol. */
  previousSource?: 'release' | 'stored';
  changePct?: number;
  changeAmount?: number;
  frequency?: DividendFrequency;
  /** Dates as YYYY-MM-DD, only those the release prints and that parse. */
  exDate?: string;
  recordDate?: string;
  payDate?: string;
}

export const BUYBACK_ACTIONS = ['new', 'increased', 'ongoing'] as const;
export type BuybackAction = (typeof BUYBACK_ACTIONS)[number];

/** Share repurchases mentioned in the release. Amounts are in whole currency units, shares as counts. */
export interface EarningsBuyback {
  status: CapitalReturnStatus;
  currency?: string;
  action?: BuybackAction;
  /** The size of a new or increased program. */
  authorization?: number;
  authorizationRaw?: string;
  /** Bought back in the period. */
  repurchased?: number;
  repurchasedRaw?: string;
  repurchasedShares?: number;
  /** Still authorized. */
  remaining?: number;
  remainingRaw?: string;
}

export interface EarningsVerification {
  /** Extracted values (numbers, quotes, bullets) that could not be found in the release text and were removed. */
  dropped: number;
  /** What was dropped, e.g. `revenue.actual`, `quote`: names only, never values. */
  droppedFields: string[];
  model: string;
  /** Workers AI neurons spent (an estimate from the documented per-token rates). */
  neuronsEstimate: number;
  /** Model calls made (1 or 2). */
  calls: number;
}

export type EarningsOrigin = 'live' | 'backfill';

export interface EarningsSummary {
  schemaVersion: number;
  symbol: string;
  name: string;
  /** Fiscal period as the release calls it ("Q3 2026", "third quarter 2026"). */
  period: string;
  /** Release date (YYYY-MM-DD): also the sort key. */
  reportDate: string;
  filingUrl: string;
  accession: string;
  form: '8-K' | '6-K';
  reportingCurrency: string;
  template: KpiTemplateId;
  /** Backfilled summaries (the first run after deploy) are recorded silently: no push. */
  origin: EarningsOrigin;
  headline: Partial<Record<CoreMetricKey, EarningsMetric>>;
  kpis: EarningsKpi[];
  guidance: EarningsGuidance[];
  segments: EarningsSegment[];
  keyUpdates: string[];
  quote?: EarningsQuote;
  /** Absent on a summary of schema version 1 (not read yet): the Earnings page says so until the backfill has read it. */
  dividend?: EarningsDividend;
  buyback?: EarningsBuyback;
  /** The report date of the stored summary used for the quarter-over-quarter figures; absent for the first stored quarter. */
  previousReportDate?: string;
  verification: EarningsVerification;
  generatedAt: string;
  status: 'ok';
  /** The analyst consensus joined to the summary by the API (EPS and revenue, beat or miss, or why there is none); never stored. */
  consensus?: SummaryConsensus;
}

/** Where the last run for a symbol ended: the first stage that did not go on, or `ok`. */
export const EARNINGS_RUN_STAGES = ['ticker-map', 'submissions', 'select-filing', 'exhibit', 'text', 'ai', 'verify', 'store', 'budget', 'sec-blocked', 'not-eligible', 'no-release-found', 'ok'] as const;
export type EarningsRunStage = (typeof EARNINGS_RUN_STAGES)[number];

/** What the pipeline did last for one symbol, sanitised: never a URL with a query, a secret or a figure from a release. */
export interface EarningsLastRun {
  at: string;
  stage: EarningsRunStage;
  /** At most 120 characters. */
  detail?: string;
  filing?: { form: string; date: string; accession: string };
  /** Figures the model gave that were not in the release and were dropped. */
  droppedNumbers?: number;
  neurons?: number;
}

export type EarningsPlanStatus = 'todo' | 'stored' | 'skipped' | 'failed';

/** One release of the backfill plan of a symbol (newest first). */
export interface EarningsPlanItem {
  accession: string;
  form: '8-K' | '6-K';
  filingDate: string;
  reportDate: string;
  primaryDocument: string;
  status: EarningsPlanStatus;
  /** Reads attempted, in total and on `triesDay` (UTC). */
  tries: number;
  triesDay?: string;
  triesToday?: number;
  /** Not tried again before this time. */
  nextTryAt?: string;
  failedAt?: string;
  reason?: string;
  /** Set to the schema version while the stored summary of this release is read again for the blocks that version added (it keeps its other figures). */
  upgrade?: number;
}

export type EarningsCheckResult = 'ok' | 'no-filing' | 'not-in-sec' | 'blocked' | 'failed' | 'unreadable' | 'ai-allowance' | 'not-configured' | 'skipped';

/** What the watcher knows about a symbol (`TICKER#{symbol}` / `EARNSTATE`). Never holds a figure from a release. */
export interface EarningsSymbolState {
  symbol: string;
  cik?: string;
  /** When the CIK lookup last failed to find the symbol (retried after 30 days). */
  cikMissingAt?: string;
  lastCheckedAt?: string;
  lastResult?: EarningsCheckResult;
  /** Short, sanitised reason of the last failure. */
  lastReason?: string;
  /** Checks made on `checksDay` (UTC). */
  checksDay?: string;
  checks?: number;
  /** Extraction attempts made on `attemptsDay` (UTC). */
  attemptsDay?: string;
  attempts?: number;
  /** Failures in a row (drives the back-off). */
  failures?: number;
  retryAfter?: string;
  lastSuccessAt?: string;
  /** The newest release a summary was produced for. */
  lastAccession?: string;
  /** Filings looked at and found not to be a results release (6-K), newest last, at most 12. */
  seenAccessions?: string[];
  /** Set once the first (backfill) attempt has been made, so it is made only once. */
  backfillDone?: true;
  /** Unreadable releases are retried once, later. */
  unreadableCount?: number;
  /** A release found by the watcher whose summary job was queued (not queued again for six hours). */
  pendingAccession?: string;
  pendingAt?: string;
  lastManualRefreshAt?: string;
  /** The structured outcome of the last run for this symbol (what the Earnings page shows). */
  lastRun?: EarningsLastRun;
  /** The backfill plan: the newest quarterly releases found at the SEC, with what became of each. */
  plan?: EarningsPlanItem[];
  planQuarters?: number;
  plannedAt?: string;
  /** The schema version the plan was last compared with the stored summaries (a lower one: the plan is checked for summaries to read again). */
  summaryVersion?: number;
  updatedAt: string;
}

// --- API -----------------------------------------------------------------------------------------------------------------

/** The held-symbol cache (`EARNINGS` / `HELD`): rebuilt every few hours from the transactions, so a watcher run reads one row. */
export interface EarningsHeldCache {
  builtAt: string;
  holdings: EarningsHolding[];
  /** Expected report dates (YYYY-MM-DD) from the calendar, per symbol. */
  calendar: Record<string, string[]>;
  /** Market symbols that were traded but are held by nobody now: "Fetch all now" drops their stored check state. */
  former?: string[];
}

/** A held company the watcher looks at (never carries amounts or quantities). */
export interface EarningsHolding {
  symbol: string;
  name: string;
  template: KpiTemplateId;
  /** The currency of the stored profile (a fallback when a release does not name its currency). */
  currency?: string;
  /** The ISIN of the stored profile: a US-prefixed one says the company files with the SEC. */
  isin?: string;
}

/** Whether the SEC refused requests (403 or 429): nothing is sent before `blockedUntil`. */
export interface EarningsSecBlock {
  blockedUntil?: string;
  failures: number;
  lastStatus?: number;
  updatedAt: string;
}

export type EarningsBackfillWait = 'allowance' | 'sec-blocked' | 'sec-error' | 'attempts' | 'ai-error';

/** The backfill of the last quarters of every holding (`EARNINGS` / `BACKFILL`): one row, read first by every scheduled step. */
export interface EarningsBackfillMarker {
  armedAt: string;
  /** `auto`: the first scheduled step after the feature was switched on (or `EARNINGS_BACKFILL_QUARTERS` changed); `manual`: "Fetch all now". */
  armedBy: 'auto' | 'manual';
  /** The schema version the run was armed under (absent: 1). A finished run of an older version is armed again, so stored summaries are read for what the new version added. */
  schemaVersion?: number;
  quarters: number;
  status: 'running' | 'complete';
  /** Why the run waits and until when (the next 00:00 UTC for the AI allowance). */
  waitUntil?: string;
  waitReason?: EarningsBackfillWait;
  /** Releases planned, finished (stored, skipped or failed), stored and failed. */
  total: number;
  done: number;
  stored: number;
  failed: number;
  /** Companies with a plan, of the companies that are eligible. */
  planned: number;
  companies: number;
  lastStepAt?: string;
  completedAt?: string;
  /** The pass that reads stored summaries again after a schema change: summaries to read again, and how many were. */
  upgrade?: EarningsUpgradeProgress;
  updatedAt: string;
}

export interface EarningsUpgradeProgress {
  total: number;
  done: number;
}

export interface EarningsBackfillStatus {
  status: 'running' | 'complete' | 'not-started';
  quarters: number;
  total: number;
  done: number;
  stored: number;
  failed: number;
  planned: number;
  companies: number;
  waitUntil?: string;
  waitReason?: EarningsBackfillWait;
  completedAt?: string;
  lastStepAt?: string;
  upgrade?: EarningsUpgradeProgress;
}

export interface EarningsListResponse {
  available: boolean;
  summaries: EarningsSummary[];
  /** The currently held symbols that have at least one summary, for the filter chips. */
  symbols: string[];
}

export interface EarningsSymbolStatus {
  symbol: string;
  eligible: boolean;
  lastCheckedAt?: string;
  lastResult?: EarningsCheckResult;
  lastReason?: string;
  retryAfter?: string;
  latestReportDate?: string;
  /** The structured outcome of the last run (additive: absent before the first run). */
  lastRun?: EarningsLastRun;
  /** Quarterly releases of the backfill plan: how many exist and how many are stored. */
  releases?: { planned: number; stored: number; failed: number };
  /** What the consensus job last did for this company (additive: absent before its first attempt). */
  consensus?: { outcome: ConsensusOutcome; at: string; detail?: string; fetchedAt?: string; retryAt?: string; source?: 'eps-only' };
}

export type EarningsNotReady = 'sec-contact' | 'ai-binding';

export interface EarningsStatusResponse {
  available: boolean;
  /** True when the SEC contact and the AI binding are both present. */
  configured: boolean;
  /** What is missing (`sec-contact`: the SEC_CONTACT variable, `ai-binding`: the Workers AI binding). */
  missing: EarningsNotReady[];
  /** Estimates of EPS need the optional Alpha Vantage key. */
  estimatesConfigured: boolean;
  secBlockedUntil?: string;
  neurons?: { used: number; dailyCap: number; allowance: number; state: 'ok' | 'warn' | 'blocked' | 'unavailable'; resetsAt: string };
  /** The backfill of the last quarters of every holding. */
  backfill?: EarningsBackfillStatus;
  /** When the oldest of the last runs of the eligible companies happened: every company was looked at since. */
  lastFullPassAt?: string;
  /** How many symbols you traded but no longer hold: they are neither listed nor counted nor checked. */
  notHeld?: number;
  /** Analyst consensus: how many of the eligible companies have figures stored, and why the job waits (the plan has no estimates, or the day's allowance is used). */
  consensus?: {
    covered: number;
    companies: number;
    blockedUntil?: string;
    blockedReason?: 'premium' | 'rate-limited';
    /** Eligible companies whose last attempt was `rate-limited`: they wait for the provider's limit to pass. */
    waiting?: number;
    /** Set while the key cannot read `EARNINGS_ESTIMATES`: the figures are EPS-only (from the free `EARNINGS` function) and there is no revenue consensus. */
    endpoint?: Pick<ConsensusEndpoint, 'state' | 'at' | 'retryAt'>;
  };
  /** The currently held symbols only (the same ones as the Dashboard's holdings). */
  symbols: EarningsSymbolStatus[];
}

export interface EarningsBackfillResponse {
  accepted: boolean;
  reason?: 'rate-limited' | 'not-configured';
  retryAfterSeconds?: number;
}

export interface EarningsRefreshResponse {
  accepted: boolean;
  /** When refused: `rate-limited` (once per hour), `not-configured`, `not-eligible`, `unknown-symbol`. */
  reason?: 'rate-limited' | 'not-configured' | 'not-eligible' | 'unknown-symbol';
  retryAfterSeconds?: number;
}

export const earningsListQuerySchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .transform((value) => value.toUpperCase())
    .optional(),
  limit: z.coerce.number().int().min(1).max(EARNINGS_MAX_LIMIT).optional(),
});

/** The report date a `GET /earnings/{symbol}/{period}` is addressed by. */
export const earningsPeriodSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'The period is the report date (YYYY-MM-DD)');
