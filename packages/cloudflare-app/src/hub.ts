import { DurableObject } from 'cloudflare:workers';
import { createConsoleLogger, setLogger } from '@portfolio/platform';
import { readHubConfig } from './config.js';
import { HubCore, type HubOptions } from './hub-core.js';
import { errorResponse } from './responses.js';
import type { HubEnv, HubState } from './runtime.js';

/**
 * The Hub Durable Object (SQLite-backed, one named instance, `idFromName('hub')`): a thin shell that builds `HubCore` from
 * the Worker's variables. Without a valid configuration it answers every request with 503 `NOT_CONFIGURED` (naming the
 * problems, never the values) and its alarm does nothing.
 */
export class Hub extends DurableObject<HubEnv> {
  /** Options of the core. Tests override this in a subclass (clock, small limits); the deployed class uses the defaults. */
  protected static hubOptions(_env: HubEnv): HubOptions {
    return {};
  }

  private readonly core: HubCore | undefined;
  private readonly problems: string[] = [];

  constructor(ctx: HubState, env: HubEnv) {
    super(ctx, env);
    setLogger(createConsoleLogger({ service: 'portfolio-tracker-hub' }));
    const config = readHubConfig(env);
    if (config.ok) {
      this.core = new HubCore(ctx, config.config, (new.target as typeof Hub).hubOptions(env));
    } else {
      this.problems = config.problems;
    }
  }

  #started: Promise<void> | undefined;

  /** Arms the alarm and the schedules once, before the first request or alarm is served (inputs stay blocked meanwhile). */
  protected started(): Promise<void> {
    const core = this.core;
    if (!core) return Promise.resolve();
    this.#started ??= this.ctx.blockConcurrencyWhile(() => core.start());
    return this.#started;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.core) {
      await this.started();
      return this.core.handle(request);
    }
    return Promise.resolve(errorResponse(503, 'NOT_CONFIGURED', `The Hub is not configured: ${this.problems.join('; ')}`));
  }

  async alarm(): Promise<void> {
    if (!this.core) return;
    await this.started();
    await this.core.alarm();
  }

  /** The core, for subclasses (tests) that add routes next to `fetch`. */
  protected get hubCore(): HubCore | undefined {
    return this.core;
  }
}
