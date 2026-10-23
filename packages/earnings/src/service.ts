import type { JobQueue } from '@portfolio/platform';
import type { EarningsNotReady, EarningsRefreshResponse, EarningsStatusResponse, EarningsSymbolStatus } from '@portfolio/shared';
import { EARNINGS_REFRESH_INTERVAL_MS } from '@portfolio/shared';
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

/** What the API needs from the feature on a deployment that has it (`Deps.earnings` of the API). */
export class EarningsService {
  constructor(private readonly deps: EarningsServiceDeps) {}

  missing(): EarningsNotReady[] {
    const missing: EarningsNotReady[] = [];
    if (this.deps.config.secUserAgent === undefined) missing.push('sec-contact');
    if (!this.deps.aiBound) missing.push('ai-binding');
    return missing;
  }

  async status(symbols: readonly SymbolRef[]): Promise<EarningsStatusResponse> {
    const { repo, config, now } = this.deps;
    const [block, neurons, states, latest] = await Promise.all([
      repo.getSecBlock(),
      this.deps.neurons(),
      repo.getStates(symbols.map((entry) => entry.symbol)),
      Promise.all(symbols.map((entry) => repo.latest(entry.symbol, 1))),
    ]);
    const missing = this.missing();
    const blockedUntil = block?.blockedUntil !== undefined && Date.parse(block.blockedUntil) > now().getTime() ? block.blockedUntil : undefined;
    const rows: EarningsSymbolStatus[] = symbols.map((entry, index) => {
      const state = states.get(entry.symbol);
      return {
        symbol: entry.symbol,
        eligible: entry.eligible,
        ...(state?.lastCheckedAt === undefined ? {} : { lastCheckedAt: state.lastCheckedAt }),
        ...(state?.lastResult === undefined ? {} : { lastResult: state.lastResult }),
        ...(state?.lastReason === undefined ? {} : { lastReason: state.lastReason }),
        ...(state?.retryAfter === undefined ? {} : { retryAfter: state.retryAfter }),
        ...(latest[index]![0] === undefined ? {} : { latestReportDate: latest[index]![0].reportDate }),
      };
    });
    return {
      available: true,
      configured: missing.length === 0,
      missing,
      estimatesConfigured: config.estimatesConfigured,
      ...(blockedUntil === undefined ? {} : { secBlockedUntil: blockedUntil }),
      neurons: { used: neurons.used, dailyCap: config.dailyNeurons, allowance: neurons.allowance, state: neurons.state, resetsAt: neurons.resetsAt },
      symbols: rows,
    };
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
