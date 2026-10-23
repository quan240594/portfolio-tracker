import { isT212Ticker, sequentially } from '@portfolio/shared';
import { silentLogger, type Logger } from '../logger.js';
import { t212LogoKey, type LogoStore, type StoredLogo } from './store.js';
import { DEFAULT_LOGO_TIMEOUT_MS, type LogoFailure, type LogoFetchResult, type LogoSource, type LogoSubject } from './sources.js';

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
  /** Lookups at the sources per clock hour; 0 = never fetch (stored logos are still served). */
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
 * The logo of a holding: the stored one, or, at most once per key, one lookup at the sources in order. The key is the Trading 212
 * ticker when a source by ticker is switched on and the holding has one (one logo per instrument), else the public domain (the
 * five iShares ETFs share one). A source is only asked for a subject it can serve (a domain source is skipped without a domain). Everything
 * is written once (one row per key, a found logo or a `missing` note with its retry time), so the cost of a logo is one lookup of
 * up to `sources.length` outbound calls and one row written, ever. A stored logo of a source that is switched off is not served and
 * is looked up again. Lookups are one at a time, counted per clock hour, and refused while the usage budget is busy; concurrent
 * requests for one key share one lookup.
 */
export class LogoService {
  private readonly inFlight = new Map<string, Promise<LogoOutcome>>();
  private hour = '';
  private lookupsThisHour = 0;
  private readonly logger: Logger;

  constructor(private readonly options: LogoServiceOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  lookup(subject: LogoSubject, fetchImpl?: typeof fetch): Promise<LogoOutcome> {
    const key = this.keyOf(subject);
    if (key === undefined) return Promise.resolve({ kind: 'missing', reason: this.options.sources.length === 0 ? 'disabled' : 'no-logo' });
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const started = this.resolve(key, subject, fetchImpl ?? this.options.fetch ?? ((input, init) => globalThis.fetch(input, init))).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  /** The row a subject is stored under, or undefined when no switched-on source can serve it. */
  private keyOf({ domain, t212Ticker }: LogoSubject): string | undefined {
    const { sources } = this.options;
    if (isT212Ticker(t212Ticker) && sources.some((source) => source.by === 't212Ticker')) return t212LogoKey(t212Ticker);
    return domain !== undefined && sources.some((source) => source.by === 'domain') ? domain : undefined;
  }

  private async resolve(key: string, subject: LogoSubject, fetchImpl: typeof fetch): Promise<LogoOutcome> {
    const entry = await this.options.store.get(key);
    if (entry?.status === 'found' && this.options.sources.some((source) => source.name === entry.source)) return { kind: 'found', logo: entry };
    if (entry?.status === 'missing' && Date.parse(entry.retryAfter) > this.options.now().getTime()) return { kind: 'missing', reason: 'cached' };
    if (this.options.sources.length === 0 || this.options.hourlyLimit <= 0) return { kind: 'missing', reason: 'disabled' };
    const refused = await this.refusal();
    if (refused !== undefined) return refused;
    return this.fetchFromSources(key, subject, fetchImpl);
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

  private async fetchFromSources(key: string, subject: LogoSubject, fetchImpl: typeof fetch): Promise<LogoOutcome> {
    const { sources, store, now, timeoutMs, maxBytes, minPixels, placeholderHashes } = this.options;
    const failures: LogoFailure[] = [];
    let found: Extract<LogoFetchResult, { ok: true }> | undefined;
    const askable = sources.filter((source) => subject[source.by] !== undefined);
    const tries = sequentially(askable, (source) => source.fetchLogo(subject, { fetch: fetchImpl, timeoutMs: timeoutMs ?? DEFAULT_LOGO_TIMEOUT_MS, maxBytes, minPixels, placeholderHashes }));
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
      const logo = await store.putFound({ key, contentType: found.logo.contentType, bytes: found.logo.bytes, source: found.source, fetchedAt: at.toISOString() });
      return { kind: 'found', logo };
    }
    const transient = failures.some((reason) => TRANSIENT.has(reason));
    const wait = transient ? TRANSIENT_RETRY_MS : this.options.negativeTtlDays * DAY_MS;
    await store.putMissing({ key, checkedAt: at.toISOString(), retryAfter: new Date(at.getTime() + wait).toISOString() });
    return { kind: 'missing', reason: 'no-logo' };
  }
}
