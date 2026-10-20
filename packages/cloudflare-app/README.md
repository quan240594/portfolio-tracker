# @portfolio/cloudflare-app

The deployable **personal** app on Cloudflare's **free plan**: one Worker (static app, GitHub sign-in, routing) in front of one
SQLite-backed Durable Object, the **Hub**, which holds the data and runs the same API, CSV import and Trading 212 sync as the
AWS Lambdas. Nothing here needs a paid plan, a payment method, R2, KV, Queues, D1 or Zero Trust. The design and the budget
tables are in the "Cloudflare personal app (Worker + Hub Durable Object)" section of
[docs/architecture.md](../../docs/architecture.md).

```
browser -> static assets (free, no Worker)            /, /assets/*, SPA fallback
        -> Worker  /auth/*  GitHub sign-in            (cookie MAC check, no Durable Object)
                   /health                            (no Durable Object)
                   PUT /api/uploads/<token>           public, size-bounded, forwarded
                   /api/*, /usage                     same-origin + session check, then forwarded with the verified subject
        -> Hub Durable Object                          budget guard -> API handler / usage / upload -> SQLite ports
        -> alarm()                                     import + Trading 212 jobs (guarded), re-arms itself
cron (daily)  -> Worker.scheduled -> Hub keep-alive    re-arms the alarm after a deploy
```

## One-time setup (owner)

You need a Cloudflare account on the Free plan and a GitHub account. Every command runs in this package
(`cd packages/cloudflare-app`) with Node 22 (wrangler needs it) after `pnpm install` at the repository root.

1. **Pick the origin.** Your Worker lives at `https://portfolio-tracker.<your-subdomain>.workers.dev` (`name` in
   `wrangler.jsonc`; the subdomain is chosen when you first register one on your Cloudflare account). You need the exact origin
   for step 2, so register the subdomain first (dashboard: Workers & Pages) or deploy once and come back.
2. **Create a GitHub OAuth App** (GitHub, Settings, Developer settings, OAuth Apps, New OAuth App). Homepage URL `<origin>`,
   Authorization callback URL `<origin>/auth/callback`, no device flow. Note the Client ID and generate a Client secret. Find
   your numeric GitHub user id at `https://api.github.com/users/<your-login>` (field `id`). Turn on two-factor authentication
   for that GitHub account: a compromised account is a compromised app.
3. **Log in to Cloudflare once:** `pnpm exec wrangler login`.
4. **Set the three Worker secrets** (prompted, never written to a file or the repository):
   ```bash
   pnpm exec wrangler secret put GITHUB_CLIENT_SECRET      # the OAuth App's client secret
   openssl rand -base64 48 | pnpm exec wrangler secret put SESSION_SECRET     # signs the session cookies (>= 32 characters)
   openssl rand -base64 32 | pnpm exec wrangler secret put SECRETS_KEY       # encrypts the stored Trading 212 credentials
                                                           # (what generateSecretsKey() makes: 32 random bytes, base64)
   ```
   (`wrangler secret put` before the first deploy creates the Worker for you; confirm when it asks.) Keep a copy of
   `SECRETS_KEY` in your password manager: without it the stored broker credentials cannot be decrypted and must be entered
   again. Rotating `SESSION_SECRET` signs every session out.
5. **Deploy**, passing the three non-secret variables (they are placeholders in `wrangler.jsonc` on purpose, so no personal
   value is ever committed):
   ```bash
   ORIGIN=https://portfolio-tracker.<your-subdomain>.workers.dev \
   OWNER_GITHUB_ID=<your numeric id> \
   GITHUB_CLIENT_ID=<the OAuth App client id> \
   pnpm run deploy:app
   ```
   It builds the web app (`VITE_AUTH_MODE=github`, no demo banner, no mock mode) into `dist/web`, then runs `wrangler deploy`
   with the Durable Object migration (`new_sqlite_classes`) and the daily cron trigger.
6. **First sign-in.** Open `<origin>`, choose "Sign in with GitHub" and authorise the OAuth App. Only the account whose id is
   `OWNER_GITHUB_ID` gets a session; any other account sees a neutral 403. Then import a CSV or connect Trading 212 as usual.
   The usage indicator (`GET /api/usage`) shows how much of the free-plan day is used.

7. **Prices.** With Trading 212 connected, **no key is needed for current prices**: the `refreshT212Quotes` job reads your open positions
   (one request) every 15 minutes on weekdays from 07:00 to 21:45 Amsterdam time plus once at 22:05, and right after every successful
   sync, and stores a quote per held symbol (`source: 't212'`); holdings and totals are then valued at those prices instead of at cost.
   It runs below 80 % of the free-plan budget (about 2 % of the daily row cap, see `docs/architecture.md`, "Trading 212 position
   quotes"); `GET /api/prices/status` (`t212Quotes`) shows its last refresh and any failure (rejected key, rate limit).
   The same run also writes a **baseline profile** for every held symbol (a real name such as "iShares ...", STOCK/ETF type, ISIN, currency, and a
   country taken from the ISIN prefix, which for an ETF is the fund's domicile), so the Allocation and Holdings views show proper names and
   classes without any key. **Charts, history, dividends, splits and sector / country of the company still need the market-data keys below**;
   until they are set the day change starts at 0 and price charts stay empty.

   **What to expect from free keys.** The free plans are small (Twelve Data: 8 credits a minute, `/profile` is not included; EODHD: 20 calls a
   day). The price jobs know that: they keep the minute and day usage in the database, remember a "limit reached" answer until the limit resets
   (next minute, or the next UTC midnight) instead of retrying, try a symbol at most 3 times a day, and fetch dividends last. With about 25 holdings
   the history of the exchange-listed ones (1 EODHD call each) can need two days to complete; nothing is lost and nothing retries every minute.
   Sector and country of a company only come from a provider profile (Alpha Vantage, or Twelve Data's reference data for the country): with free
   keys set them yourself, below.

   **Classify your holdings yourself (owner override, wins over every provider).** On the *Assets* page, "Asset classification" imports the
   Snowball **Holdings** CSV export: the file is read in your browser (Holding, Holdings' name, Sector, Country, Category, ISIN and Currency are
   used, nothing else is sent), you get a preview of every row (matched by ISIN first, then by ticker, e.g. `FWRA` to `FWRA.MI`; rows that cannot
   be matched are listed with the reason, never guessed) and confirm. Categories become asset classes (`Funds` = ETF, `Commodities` = Commodity,
   `Crypto` = Crypto, sector names = Stock), GICS sectors are renamed to the app's sector names (`Information Technology` = Technology, ...).
   A single asset is edited from its detail page ("Edit classification"). The mapping tables are in `docs/architecture.md`,
   "Instrument classification (baseline, providers, overrides)".

   **Optional: market-data keys** (the price service). Without them prices come from Trading 212 as above (else they keep their last stored value) and only
   exchange rates (keyless ECB source) refresh; `GET /api/prices/status` shows which source is off and which secret switches it on.
   Each one is a Worker secret, set the same way as in step 4:
   ```bash
   pnpm exec wrangler secret put TWELVEDATA_API_KEY     # quotes, history, profiles of US-listed symbols
   pnpm exec wrangler secret put EODHD_API_KEY          # exchange-suffixed symbols (.AS, .DE, ...), dividends, splits
   pnpm exec wrangler secret put COINGECKO_API_KEY      # crypto (demo key)
   pnpm exec wrangler secret put ALPHAVANTAGE_API_KEY   # US company profiles, earnings calendar
   ```
   Free-tier limits and tuning variables (`EODHD_DAILY_LIMIT`, `EU_REFRESH_HOURS`, `FX_HISTORY_START`, `CALENDAR_*`, ...) are those of
   `@portfolio/prices` (`parsePricesConfig`); put one in `vars` of `wrangler.jsonc` only to change its default. The refreshes run
   from the Hub alarm on the `prices-refresh` and `prices-calendar` schedules and only below 60 % of the free-plan budget. A provider quote is
   replaced by a newer Trading 212 one and replaces it again at its next refresh.

   **Company logos (optional, nothing to set up).** The calendar, asset header, holdings and top holdings show company logos. The browser only asks
   your own app (`GET /api/logos/<symbol>`); the Hub fetches each logo **once** from a keyless public icon service by company domain (never your holdings
   list), stores it in its database (one row, at most 40 KB) and serves it with a day-long private cache. Missing logos fall back to a monogram. Wrong or
   missing logo: *Edit classification* on the asset, field *Website domain*. Optional variables (`wrangler.jsonc` `vars`): `LOGO_SOURCES` (comma
   separated, order = priority, default `logodev,google,duckduckgo`, `off` = no logos), `LOGO_HOURLY_LIMIT` (default 30 lookups an hour),
   `LOGO_NEGATIVE_TTL_DAYS` (default 7); optional secret `LOGO_DEV_TOKEN` (`pnpm exec wrangler secret put LOGO_DEV_TOKEN`) switches a token-based source on
   and puts it first. Cost: 1 row written per logo, once; terms-of-use caveat and everything else in `docs/architecture.md`, "Company logos".

Until the variables and secrets are valid, every API and sign-in route answers 503 `NOT_CONFIGURED` naming the missing
variable (never a value); `/health` and the static app keep working.

> **Corporate laptop:** `*.workers.dev` is blocked on many managed networks and `wrangler tail` may be too. Do the
> deploy and the first sign-in from a personal device or network (the app itself is just HTTPS afterwards).

## Identity-required mode

The API's `authMode` is `cognito` in this deployment. That name is historical: it means **identity required** (no identity, no
access: the API answers 401 and never falls back to a demo user). The Hub passes the Worker-verified GitHub owner as the identity
(`github:<id>` becomes the user id `github-<id>`), so the same fail-closed code path as behind the AWS authorizer applies.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in a separate dev OAuth App (callback http://localhost:8787/auth/callback); gitignored
pnpm run dev                     # builds the web app, then `wrangler dev --local` on http://localhost:8787 (no Cloudflare account, works offline)
```

Signing in needs GitHub, so offline you can see the app shell and `/health`; the API answers 401 until you sign in.
`pnpm run deploy:dry-run` bundles exactly what `wrangler deploy` would upload (no network, no login) into `dist/bundle`.

## Scripts and tests

| Script | What it does |
|---|---|
| `dev` | build the web app, `wrangler dev --local` |
| `build:web` | build `web` for this deployment into `dist/web` (`VITE_AUTH_MODE=github`, `/api` on the same origin, no mocks) |
| `deploy:app` | `build:web` + `wrangler deploy` with the three variables from the environment (refuses to run without them) |
| `deploy:dry-run` | `build:web` + `wrangler deploy --dry-run` |
| `typecheck`, `lint` | as everywhere |
| `test`, `test:coverage` | unit tests + the whole-app suite in Node and in real workerd |

`pnpm --filter @portfolio/cloudflare-app test` needs no network and no secrets:

- `test/logos-suite.ts` runs the **company logo** route through the same stacks (Node and workerd) against fake icon services (`FakeLogos`):
  auth, one outbound fetch per domain, ETag/304, cached miss, override domain, hourly cap, `LOGO_SOURCES=off`, the token source.
- `src/*.test.ts` unit-test the configuration, body limits, subject mapping, subrequest budget, the guarded job registry (priority,
  deferral, the price-service registration point), the Hub core and the Worker routing.
- `test/suite.ts` is **one suite of the whole app**: GitHub sign-in (full OAuth round trip against a fake GitHub), anonymous 401,
  forged cookie, cross-origin 403, the platform-neutral API scenarios from `@portfolio/api/testing` (the same ones that run on
  the in-memory dependencies and on LocalStack), CSV upload -> alarm -> data, Trading 212 sync through resumable alarm steps
  (fake Trading 212), the Trading 212 position quotes (a sync followed by an immediate refresh, non-stale holdings valued in the base currency
  without any key, 401/429/500 recorded and backed off, guard at 60-80 % and 80 %), the price service (schedules arm the alarm, a refresh step writes prices the API serves, jobs skipped from
  60 % of a cap, graceful degradation without provider keys; fake Twelve Data, Alpha Vantage and Frankfurter), `GET /api/usage`, the 429 `BUDGET_EXHAUSTED` guard, alarm and cron re-arming. It runs twice:
  `test/node.test.ts` (real Worker and Hub code over SQLite compiled to WebAssembly, pinned clock; **this is what coverage
  measures**) and `test/workerd.test.ts` (the same suite against the esbuild bundle in real workerd through Miniflare, with a
  SQLite-backed Durable Object, real alarms and the static assets binding).
- A real network call fails the test (`test/setup.ts`); GitHub and Trading 212 are fakes (`test/fakes.ts`).
