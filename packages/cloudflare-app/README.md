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
   **Charts, history, dividends, splits and company profiles still need EOD data from the market-data keys below**; until they are set the
   day change starts at 0 and price charts stay empty.

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
