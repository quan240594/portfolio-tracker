/** Outbound `fetch` calls one invocation may make on the free plan. */
export const SUBREQUEST_LIMIT = 50;
/** What the Hub plans for: a few calls below the limit stay unused as headroom for retries of the runtime itself. */
export const SUBREQUEST_CEILING = 45;

/** Thrown instead of making a call that would pass the ceiling (the Workers runtime would fail it anyway). */
export class SubrequestLimitError extends Error {
  constructor(limit: number) {
    super(`Subrequest budget of ${limit} calls for this invocation is used up`);
    this.name = 'SubrequestLimitError';
  }
}

/**
 * Counts the outbound calls of one invocation (a request or an alarm run). Jobs ask `remaining()` before a step and make
 * their calls through `wrap(fetch)`, which refuses a call over the ceiling instead of letting the runtime reject it.
 */
export class SubrequestBudget {
  #used = 0;

  constructor(private readonly limit: number = SUBREQUEST_CEILING) {}

  get used(): number {
    return this.#used;
  }

  remaining(): number {
    return Math.max(0, this.limit - this.#used);
  }

  wrap(fetchImpl: typeof fetch): typeof fetch {
    return (input, init) => {
      if (this.#used >= this.limit) return Promise.reject(new SubrequestLimitError(this.limit));
      this.#used += 1;
      return fetchImpl(input, init);
    };
  }
}
