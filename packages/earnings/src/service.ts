import type { JobQueue } from '@portfolio/platform';
import type { ConsensusBlock, ConsensusState, EarningsBackfillMarker, EarningsBackfillResponse, EarningsBackfillStatus, EarningsNotReady, EarningsRefreshResponse, EarningsStatusResponse, EarningsSymbolState, EarningsSymbolStatus } from '@portfolio/shared';
import { EARNINGS_REFRESH_INTERVAL_MS } from '@portfolio/shared';
import { armedMarker } from './backfill.js';
import type { EarningsConfig } from './config.js';
import type { EarningsRepository } from './repository.js';

export interface NeuronsToday {
  used: number;
  /** The Free plan's daily allowance (10,000). */
  allowance: number;
  state: 'ok' | 'warn' | 'blocked' | 'unavailable';
  resetsAt: string;
}

export interface EarningsServiceDeps {
  repo: EarningsRepository;
  config: EarningsConfig;
  /** Whether the Workers AI binding exists. */
  aiBound: boolean;
  queue: JobQueue;
  now: () => Date;
  neurons: () => Promise<NeuronsToday>;
}

export interface SymbolRef {
  symbol: string;
  /** Whether the instrument has earnings at all (a stock; not an ETF, crypto, ...). */
  eligible: boolean;
}

/** Releases of the plan of a symbol: how many are wanted, stored and given up on. */
function releasesOf(state: EarningsSymbolState | undefined): Pick<EarningsSymbolStatus, 'releases'> {
  if (state?.plan === undefined) return {};
  const count = (status: string): number => state.plan!.filter((item) => item.status === status && item.upgrade === undefined).length;
  // A release read again for the new blocks still has its summary: it counts as stored.
  const reread = state.plan.filter((item) => item.upgrade !== undefined && item.status !== 'skipped').length;
  return { releases: { planned: count('todo') + count('stored') + count('failed') + reread, stored: count('stored') + reread, failed: count('failed') } };
}

function backfillStatus(marker: EarningsBackfillMarker | null, quarters: number, now: Date): EarningsBackfillStatus {
  if (marker === null) return { status: 'not-started', quarters, total: 0, done: 0, stored: 0, failed: 0, planned: 0, companies: 0 };
  return {
    status: marker.status,
    quarters: marker.quarters,
    total: marker.total,
    done: marker.done,
    stored: marker.stored,
    failed: marker.failed,
    planned: marker.planned,
    companies: marker.companies,
    ...(marker.waitUntil === undefined || Date.parse(marker.waitUntil) <= now.getTime() ? {} : { waitUntil: marker.waitUntil }),
    ...(marker.waitReason === undefined ? {} : { waitReason: marker.waitReason }),
    ...(marker.completedAt === undefined ? {} : { completedAt: marker.completedAt }),
    ...(marker.lastStepAt === undefined ? {} : { lastStepAt: marker.lastStepAt }),
    ...(marker.upgrade === undefined ? {} : { upgrade: marker.upgrade }),
  };
}

/** The oldest last run of the eligible companies: every one of them was looked at since then. Absent while one was never looked at. */
function fullPass(rows: readonly EarningsSymbolStatus[]): { lastFullPassAt?: string } {
  const eligible = rows.filter((row) => row.eligible);
  const times = eligible.flatMap((row) => (row.lastRun === undefined ? [] : [row.lastRun.at]));
  return eligible.length > 0 && times.length === eligible.length ? { lastFullPassAt: times.toSorted((a, b) => a.localeCompare(b))[0] } : {};
}

/** What the consensus job last did for a symbol, as the status shows it. */
function consensusOf(state: ConsensusState | undefined): Pick<EarningsSymbolStatus, 'consensus'> {
  if (state === undefined) return {};
  return { consensus: { outcome: state.outcome, at: state.at, ...(state.detail === undefined ? {} : { detail: state.detail }), ...(state.fetchedAt === undefined ? {} : { fetchedAt: state.fetchedAt }), ...(state.retryAt === undefined ? {} : { retryAt: state.retryAt }) } };
}

/** "Consensus estimates: N of M companies": the eligible companies with figures stored, and why the job waits when it does. */
function consensusTotals(rows: readonly EarningsSymbolStatus[], block: ConsensusBlock | null, now: Date): NonNullable<EarningsStatusResponse['consensus']> {
  const eligible = rows.filter((row) => row.eligible);
  const waiting = block !== null && Date.parse(block.until) > now.getTime();
  const limited = eligible.filter((row) => row.consensus?.outcome === 'rate-limited' && row.consensus.fetchedAt === undefined).length;
  return {
    covered: eligible.filter((row) => row.consensus?.fetchedAt !== undefined).length,
    companies: eligible.length,
    ...(waiting ? { blockedUntil: block.until, blockedReason: block.reason } : {}),
    ...(limited === 0 ? {} : { waiting: limited }),
  };
}

/** What the API needs from the feature on a deployment that has it (`Deps.earnings` of the API). */
export class EarningsService {
  constructor(private readonly deps: EarningsServiceDeps) {}

  /** Whether the optional Alpha Vantage key (analyst consensus and EPS estimates) is set. */
  get estimatesConfigured(): boolean {
    return this.deps.config.estimatesConfigured;
  }

  missing(): EarningsNotReady[] {
    const missing: EarningsNotReady[] = [];
    if (this.deps.config.secUserAgent === undefined) missing.push('sec-contact');
    if (!this.deps.aiBound) missing.push('ai-binding');
    return missing;
  }

  async status(symbols: readonly SymbolRef[]): Promise<EarningsStatusResponse> {
    const { repo, config, now } = this.deps;
    const names = symbols.map((entry) => entry.symbol);
    const [block, neurons, states, latest, marker, consensus, consensusBlock] = await Promise.all([
      repo.getSecBlock(),
      this.deps.neurons(),
      repo.getStates(names),
      Promise.all(symbols.map((entry) => repo.latest(entry.symbol, 1))),
      repo.getBackfill(),
      repo.getConsensusStates(names),
      repo.getConsensusBlock(),
    ]);
    const missing = this.missing();
    const blockedUntil = block?.blockedUntil !== undefined && Date.parse(block.blockedUntil) > now().getTime() ? block.blockedUntil : undefined;
    const rows: EarningsSymbolStatus[] = symbols.map((entry, index) => {
      const state = states.get(entry.symbol);
      const lastRun = entry.eligible ? state?.lastRun : { at: now().toISOString(), stage: 'not-eligible' as const, detail: 'no quarterly results (a fund, crypto or similar)' };
      return {
        symbol: entry.symbol,
        eligible: entry.eligible,
        ...(state?.lastCheckedAt === undefined ? {} : { lastCheckedAt: state.lastCheckedAt }),
        ...(state?.lastResult === undefined ? {} : { lastResult: state.lastResult }),
        ...(state?.lastReason === undefined ? {} : { lastReason: state.lastReason }),
        ...(state?.retryAfter === undefined ? {} : { retryAfter: state.retryAfter }),
        ...(latest[index]![0] === undefined ? {} : { latestReportDate: latest[index]![0].reportDate }),
        ...(lastRun === undefined ? {} : { lastRun }),
        ...releasesOf(state),
        ...consensusOf(consensus.get(entry.symbol)),
      };
    });
    return {
      available: true,
      configured: missing.length === 0,
      missing,
      estimatesConfigured: config.estimatesConfigured,
      ...(blockedUntil === undefined ? {} : { secBlockedUntil: blockedUntil }),
      neurons: { used: neurons.used, dailyCap: config.dailyNeurons, allowance: neurons.allowance, state: neurons.state, resetsAt: neurons.resetsAt },
      backfill: backfillStatus(marker, config.backfillQuarters, now()),
      ...fullPass(rows),
      consensus: consensusTotals(rows, consensusBlock, now()),
      symbols: rows,
    };
  }

  /**
   * "Fetch all now" is the "Rescan all": the backfill starts over with empty counters (its first step, a job, re-derives the current holdings,
   * drops the check state of sold ones and plans every holding again); at most once an hour.
   */
  async backfill(): Promise<EarningsBackfillResponse> {
    const { repo, queue, config } = this.deps;
    if (this.missing().length > 0) return { accepted: false, reason: 'not-configured' };
    const now = this.deps.now();
    const marker = await repo.getBackfill();
    const age = marker?.armedBy === 'manual' ? now.getTime() - Date.parse(marker.armedAt) : Number.POSITIVE_INFINITY;
    if (age < EARNINGS_REFRESH_INTERVAL_MS) return { accepted: false, reason: 'rate-limited', retryAfterSeconds: Math.ceil((EARNINGS_REFRESH_INTERVAL_MS - age) / 1000) };
    await repo.putBackfill(armedMarker(config.backfillQuarters, 'manual', now));
    await queue.enqueue({ job: 'backfillEarnings', payload: { trigger: 'manual' } });
    return { accepted: true };
  }

  /** The owner asks for a re-check of one symbol: at most once an hour; the check itself runs as a job. */
  async refresh(symbol: string, eligible: boolean): Promise<EarningsRefreshResponse> {
    const { repo, queue } = this.deps;
    if (this.missing().length > 0) return { accepted: false, reason: 'not-configured' };
    if (!eligible) return { accepted: false, reason: 'not-eligible' };
    const now = this.deps.now();
    const state = await repo.getState(symbol);
    const last = state?.lastManualRefreshAt === undefined ? undefined : Date.parse(state.lastManualRefreshAt);
    if (last !== undefined && now.getTime() - last < EARNINGS_REFRESH_INTERVAL_MS) {
      return { accepted: false, reason: 'rate-limited', retryAfterSeconds: Math.ceil((last + EARNINGS_REFRESH_INTERVAL_MS - now.getTime()) / 1000) };
    }
    // A release the watcher gave up on is looked at again when the owner asks.
    await repo.patchState(symbol, { lastManualRefreshAt: now.toISOString(), seenAccessions: undefined, unreadableCount: undefined, retryAfter: undefined, pendingAt: undefined, pendingAccession: undefined }, now);
    await queue.enqueue({ job: 'watchEarnings', payload: { trigger: 'manual', symbol } });
    return { accepted: true };
  }
}
