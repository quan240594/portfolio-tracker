# @portfolio/prices

The price service of `services/prices` (Python) in TypeScript, for platforms that run on Web-standard APIs only
(Cloudflare Workers and Durable Objects, Node, tests). It implements the market-data types of `@portfolio/platform` and
the three price jobs (`refreshPrices`, `enrichTransactions`, `refreshCalendar`) as resumable `JobHandler`s.

No Node built-ins, no cloud SDK, no global state: `fetch`, the clock, `sleep` and the configuration (API keys) are injected,
persistence goes through the `ItemStore` port, and the data layout is the one the Python service writes, so the API reads it
unchanged. The Python service stays as it is (the AWS stack keeps using it).

```ts
import { createPriceJobs, parsePricesConfig } from '@portfolio/prices';

const jobs = createPriceJobs({
  store, // an ItemStore
  fetch, // the platform's fetch
  clock: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  config: parsePricesConfig(env), // TWELVEDATA_API_KEY, EODHD_API_KEY, COINGECKO_API_KEY, ALPHAVANTAGE_API_KEY, ...
  stepSubrequests: 40, // fetches (retries included) per step; the free Worker/DO cap is 50
});
// jobs.refreshPrices / jobs.enrichTransactions / jobs.refreshCalendar are JobHandlers: call them with `{ payload, cursor }`,
// persist `next` and call again after `delayMs` while a step answers `{ done: false }`.
```

`createMarketDataService(deps)` runs the same jobs to completion inside one call (`MarketDataService` of the platform).

See [docs/architecture.md](../../docs/architecture.md), section "Price service in TypeScript", for the contracts, data sources,
limits, the parity test list and the open issues.

```bash
pnpm --filter @portfolio/prices test            # unit + parity tests
pnpm --filter @portfolio/prices test:coverage   # with the coverage thresholds
pnpm --filter @portfolio/prices typecheck && pnpm --filter @portfolio/prices lint
```

`test-fixtures/parity-cases.json` holds provider payloads with the results of the Python code; regenerate it with
`test-fixtures/generate_parity_cases.py` (needs the Python service's dev environment, see the header of that file).
