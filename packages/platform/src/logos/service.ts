import { sequentially } from '@portfolio/shared';
import { silentLogger, type Logger } from '../logger.js';
import type { LogoStore, StoredLogo } from './store.js';
import { DEFAULT_LOGO_TIMEOUT_MS, type LogoFailure, type LogoFetchResult, type LogoSource } from './sources.js';

export type LogoOutcome =
  | { kind: 'found'; logo: StoredLogo }
  /** Nothing to show: asked before and nobody had it (`cached`), no source is switched on (`disabled`) or none had it just now. */
  | { kind: 'missing'; reason: 'cached' | 'disabled' | 'no-logo' }
  /** Over the hourly cap or the usage budget: nothing was fetched, ask again after `retryAfterSeconds`. */
  | { kind: 'limited'; retryAfterSeconds: number };

export interface LogoServiceOptions {
  store: LogoStore;
  sources: readonly LogoSource[];
  /** The `fetch` of the lookups when `lookup` is not given one; the Hub gives each lookup its own counted one. */
  fetch?: typeof fetch;
  now: () => Date;
  /** Domains looked up at the sources per clock hour; 0 = never fetch (stored logos are still served). */
  hourlyLimit: number;
  negativeTtlDays: number;
  /** Asked once before a lookup reaches the sources (the Hub's `guardJob`): false = the usage budget is too busy, nothing is fetched. */
  allowFetch?: () => Promise<boolean>;
  timeoutMs?: number;
  maxBytes?: number;
  minPixels?: number;
  placeholderHashes?: ReadonlySet<string>;
  logger?: Logger;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A network or server failure may pass: ask again soon instead of caching the miss for days. */
const TRANSIENT_RETRY_MS = HOUR_MS;
const BUDGET_RETRY_SECONDS = 600;
const TRANSIENT: ReadonlySet<LogoFailure> = new Set(['timeout', 'network', 'http-error']);

/**
 * The logo of a public domain: the stored one, or, at most once per domain, one lookup at the sources in order. Everything is
 * written once (one row per domain, a found logo or a `missing` note with its retry time), so the cost of a logo is one lookup
 * of up to `sources.length` outbound calls and one row written, ever. Lookups are one domain at a time, counted per clock hour,
 * and refused while the usage budget is busy; concurrent requests for one domain share one lookup.
 */
export class LogoService {
  private readonly inFlight = new Map<string, Promise<LogoOutcome>>();
  private hour = '';
  private lookupsThisHour = 0;
  private readonly logger: Logger;

  constructor(private readonly options: LogoServiceOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  lookup(domain: string, fetchImpl?: typeof fetch): Promise<LogoOutcome> {
    const running = this.inFlight.get(domain);
    if (running !== undefined) return running;
    const started = this.resolve(domain, fetchImpl ?? this.options.fetch ?? ((input, init) => globalThis.fetch(input, init))).finally(() => this.inFlight.delete(domain));
    this.inFlight.set(domain, started);
    return started;
  }

  private async resolve(domain: string, fetchImpl: typeof fetch): Promise<LogoOutcome> {
    const entry = await this.options.store.get(domain);
    if (entry?.status === 'found') return { kind: 'found', logo: entry };
    if (entry !== undefined && Date.parse(entry.retryAfter) > this.options.now().getTime()) return { kind: 'missing', reason: 'cached' };
    if (this.options.sources.length === 0 || this.options.hourlyLimit <= 0) return { kind: 'missing', reason: 'disabled' };
    const refused = await this.refusal();
    if (refused !== undefined) return refused;
    return this.fetchFromSources(domain, fetchImpl);
  }

  /** Budget guard first, then the per-hour count: a refused lookup counts nothing. */
  private async refusal(): Promise<LogoOutcome | undefined> {
    if (this.options.allowFetch !== undefined && !(await this.options.allowFetch())) return { kind: 'limited', retryAfterSeconds: BUDGET_RETRY_SECONDS };
    const now = this.options.now();
    const hour = now.toISOString().slice(0, 13);
    if (hour !== this.hour) {
      this.hour = hour;
      this.lookupsThisHour = 0;
    }
    if (this.lookupsThisHour >= this.options.hourlyLimit) return { kind: 'limited', retryAfterSeconds: Math.max(1, Math.ceil((HOUR_MS - (now.getTime() % HOUR_MS)) / 1000)) };
    this.lookupsThisHour += 1;
    return undefined;
  }

  private async fetchFromSources(domain: string, fetchImpl: typeof fetch): Promise<LogoOutcome> {
    const { sources, store, now, timeoutMs, maxBytes, minPixels, placeholderHashes } = this.options;
    const failures: LogoFailure[] = [];
    let found: Extract<LogoFetchResult, { ok: true }> | undefined;
    const tries = sequentially(sources, (source) => source.fetchLogo(domain, { fetch: fetchImpl, timeoutMs: timeoutMs ?? DEFAULT_LOGO_TIMEOUT_MS, maxBytes, minPixels, placeholderHashes }));
    for await (const result of tries) {
      if (result.ok) {
        found = result;
        break;
      }
      failures.push(result.reason);
      this.logger.info('Logo source had no usable logo', { source: result.source, reason: result.reason });
    }
    const at = now();
    if (found !== undefined) {
      const logo = await store.putFound({ domain, contentType: found.logo.contentType, bytes: found.logo.bytes, source: found.source, fetchedAt: at.toISOString() });
      return { kind: 'found', logo };
    }
    const transient = failures.some((reason) => TRANSIENT.has(reason));
    const wait = transient ? TRANSIENT_RETRY_MS : this.options.negativeTtlDays * DAY_MS;
    await store.putMissing({ domain, checkedAt: at.toISOString(), retryAfter: new Date(at.getTime() + wait).toISOString() });
    return { kind: 'missing', reason: 'no-logo' };
  }
}
