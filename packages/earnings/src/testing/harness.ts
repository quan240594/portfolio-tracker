import { MemoryItemStore, MemoryJobQueue, type JobRegistry } from '@portfolio/platform';
import { WorkersAiExtractor, type NeuronMeter } from '../ai.js';
import { parseEarningsConfig, type EarningsConfig } from '../config.js';
import { createBackfillEarningsJob } from '../backfill.js';
import type { EarningsInputs, EarningsJobDeps } from '../common.js';
import { createFetchEarningsSummaryJob, createWatchEarningsJob } from '../jobs.js';
import { EarningsRepository } from '../repository.js';
import { SecClient } from '../sec.js';
import { FakeAi } from './fake-ai.js';
import { FakeSec, type FilingSpec } from './fake-sec.js';
import type { EarningsHolding } from '@portfolio/shared';
import type { EstimateSource } from '../estimates.js';

/** Tuesday 21 Oct 2026, 21:30 Amsterdam (CEST): US results of the day are out. */
export const NOW = new Date('2026-10-21T19:30:00.000Z');

export class TestClock {
  constructor(public current: Date = NOW) {}
  readonly now = (): Date => new Date(this.current);
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** A neuron meter with a fixed daily allowance. */
export class TestMeter implements NeuronMeter {
  spent = 0;
  constructor(private readonly allowance = 6000) {}
  remaining(): Promise<number> {
    return Promise.resolve(Math.max(0, this.allowance - this.spent));
  }
  spend(neurons: number): Promise<void> {
    this.spent += neurons;
    return Promise.resolve();
  }
}

export interface EarningsHarness {
  store: MemoryItemStore;
  repo: EarningsRepository;
  sec: FakeSec;
  ai: FakeAi;
  meter: TestMeter;
  clock: TestClock;
  queue: MemoryJobQueue;
  deps: EarningsJobDeps;
  config: EarningsConfig;
  holdings: EarningsHolding[];
  calendar: Record<string, string[]>;
  registry: JobRegistry;
}

export interface HarnessOptions {
  filings?: readonly FilingSpec[];
  tickers?: Record<string, { cik: number; title: string }>;
  holdings?: EarningsHolding[];
  calendar?: Record<string, string[]>;
  ai?: FakeAi;
  configured?: boolean;
  start?: Date;
  allowance?: number;
  estimates?: EstimateSource;
  /** Environment of the feature (`EARNINGS_BACKFILL_QUARTERS`, ...), merged over the configured defaults. */
  env?: Record<string, string>;
}

/** The whole feature on in-memory fakes: the watcher and the fetch job registered on a `MemoryJobQueue`. */
export function earningsHarness(options: HarnessOptions = {}): EarningsHarness {
  const clock = new TestClock(options.start ?? NOW);
  const store = new MemoryItemStore();
  const repo = new EarningsRepository(store);
  const sec = new FakeSec(options.filings ?? [], options.tickers ?? {});
  const ai = options.ai ?? new FakeAi({});
  const meter = new TestMeter(options.allowance);
  const config = parseEarningsConfig(options.configured === false ? {} : { SEC_CONTACT: 'PortfolioTracker/1.0 (personal use; owner@example.invalid)', ALPHAVANTAGE_API_KEY: 'av-test-key', ...options.env });
  const holdings = options.holdings ?? [];
  const calendar = options.calendar ?? {};
  const inputs: EarningsInputs = { build: () => Promise.resolve({ holdings, calendar }) };
  const registry: JobRegistry = {};
  const queue = new MemoryJobQueue(registry);
  const deps: EarningsJobDeps = {
    repo,
    inputs,
    config,
    ...(config.secUserAgent === undefined ? {} : { sec: new SecClient({ userAgent: config.secUserAgent, fetch: sec.fetch, now: clock.now, sleep: (ms) => {
          clock.advance(ms);
          return Promise.resolve();
        },
      }) }),
    extractor: new WorkersAiExtractor({ ai, meter, model: config.model }),
    neurons: meter,
    queue,
    now: clock.now,
    ...(options.estimates === undefined ? {} : { estimates: options.estimates }),
  };
  registry.watchEarnings = createWatchEarningsJob(() => deps);
  registry.fetchEarningsSummary = createFetchEarningsSummaryJob(() => deps);
  registry.backfillEarnings = createBackfillEarningsJob(() => deps);
  registry.notifyDividends = () => Promise.resolve({ done: true, result: {} });
  return { store, repo, sec, ai, meter, clock, queue, deps, config, holdings, calendar, registry };
}
