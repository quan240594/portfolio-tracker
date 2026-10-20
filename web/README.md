# @portfolio/web

React SPA for **Portfolio Tracker** — dashboard, holdings, dividends and transactions (incl. CSV import), for one
portfolio or several combined.

Stack: Vite 5 · React 18 · TypeScript (strict) · React Router 6 · TanStack Query 5 · Recharts · Tailwind CSS 4 · zod
(shared schemas from `@portfolio/shared`) · Vitest + Testing Library + MSW 2 · Playwright.

## Running

From the repo root (`pnpm install` once):

```bash
# Against the local API (services/api on :3001 — see docs/architecture.md "Local development")
pnpm --filter @portfolio/web dev        # http://localhost:5173, /api/* → http://localhost:3001 (prefix stripped)

# Fully mocked in the browser — no backend needed (MSW service worker + in-memory demo portfolio)
pnpm --filter @portfolio/web dev:mock   # http://localhost:5173
```

Mock mode shows a non-dismissable "Demo mode" banner and keeps state in memory per page load. It seeds two portfolios — `default` "Main portfolio" (EUR ETFs, ASML,
BTC) and `trading-212` "Trading 212" (the US stocks) — and implements the portfolio endpoints and `?portfolioId=`
scoping with the API's rules and error codes (409 `CONFLICT`/`PORTFOLIO_NOT_EMPTY`/`LAST_PORTFOLIO`, 422 above
`MAX_PORTFOLIOS`, 404 for unknown ids). Adding/deleting transactions and CSV imports recompute holdings,
allocation, history and dividends with the shared calculators in `@portfolio/shared`; a reload resets the demo data.
The demo includes a seeded daily EUR/USD history (USD per 1 EUR drifting ~1.04 → 1.17 over the year) that is passed as
`fxHistory` to the calculators, so USD holdings show a realistic (negative) currency effect; two USD buys carry a broker
`fxRate`.

## Scripts

| Script | What it does |
|---|---|
| `dev` | Vite dev server on :5173 with the `/api` proxy |
| `dev:mock` | Vite in `mock` mode (MSW in the browser) |
| `build` | `tsc -b && vite build` → `dist/` |
| `build:mock` | Production build that runs fully mocked (static demo) |
| `build:pages` | GitHub Pages build: mocked (`--mode mock`, `VITE_USE_MOCKS=true`, empty `VITE_API_BASE_URL`) under `VITE_BASE_PATH=/portfolio-tracker/`; also writes `dist/404.html` + `dist/.nojekyll` |
| `preview` | Serve `dist/` |
| `preview:pages` | Serve the `build:pages` output at http://localhost:4173/portfolio-tracker/ |
| `typecheck` | `tsc -b --noEmit` |
| `lint` | ESLint (typescript-eslint + react-hooks) |
| `test` | Vitest unit/component tests (jsdom + MSW node server) |
| `test:e2e` | Playwright (chromium): `e2e/` against `pnpm dev:mock --port $E2E_PORT` (default 5174), then `e2e-auth/` (`playwright.auth.config.ts`, a Cognito-mode build on `$E2E_AUTH_PORT`, default `$E2E_PORT`+100) proving the sign-in gate, then `e2e-github/` (`playwright.github.config.ts`, a GitHub-mode build on `$E2E_GITHUB_PORT`, default `$E2E_PORT`+200; `/auth/*` and `/api/*` are route mocks) covering sign-in, the app, sign-out, expiry and 320/1280 px layout |
| `test:e2e:pages` | `build:pages`, then Playwright (`playwright.pages.config.ts`, `e2e/pages.spec.ts`) against `dist/` served under `/portfolio-tracker/` by `scripts/serve-pages.mjs`, a GitHub-Pages-like static server (404.html fallback with status 404, `/portfolio-tracker` → 301) |

First-time E2E setup: `pnpm --filter @portfolio/web exec playwright install chromium`.

## Environment variables

Build-time (Vite `VITE_*`), see `.env.example`:

| Var | Default | Notes |
|---|---|---|
| `VITE_API_BASE_URL` | `/api` | API base. In AWS set to the API Gateway URL at build time. With `VITE_AUTH_MODE=github` it must stay same-origin (empty or a path such as `/api`): the session cookie is never sent cross-origin, so an absolute URL makes the app refuse to start. |
| `VITE_USE_MOCKS` | `false` | `true` enables the MSW browser worker and the "Demo mode" banner. `--mode mock` (used by `dev:mock`/`build:mock`/`build:pages`) implies it. |
| `VITE_AUTH_MODE` | `none` | `cognito` puts every route behind the Cognito sign-in (TOTP MFA); `github` puts every route behind the Worker's "Sign in with GitHub" session cookie (personal Cloudflare deployment, SPA and API on one origin, no further settings; see `docs/architecture.md`, "Web: GitHub sign-in mode"). Any other value fails closed with a configuration error. Ignored in mock mode. Set by the deploy workflow from the Terraform outputs (`cognito`). |
| `VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID` | – | Required when `VITE_AUTH_MODE=cognito` (otherwise the app shows a configuration error instead of starting). |
| `VITE_COGNITO_REGION` | from pool id | Optional; derived from the pool id (`eu-west-1_xxx`). |
| `VITE_REAL_APP_URL` | – | Demo mode only. https URL of your own deployed app: the banner's "Switch to real data" becomes a link to it (anything not https is ignored); unset opens a how-to dialog. The Pages workflow sets it from the repo variable `REAL_APP_URL`. |
| `VITE_BASE_PATH` | `/` | Public base path (Vite `base`, slashes normalised). The router `basename` is derived from it, and the MSW worker is loaded from `<base>mockServiceWorker.js`. `build:pages` sets `/portfolio-tracker/`. |

## GitHub Pages demo

<https://quan240594.github.io/portfolio-tracker/> is the `build:pages` output, deployed by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) (see the root README, *Deployment (GitHub Pages)*).
Notes for sub-path hosting:

- Every internal link goes through React Router (`basename` = `BASE_URL` without trailing slash); Vite rewrites
  `index.html` asset URLs (e.g. the favicon) to the base. Don't hard-code root-absolute URLs — use `import.meta.env.BASE_URL`.
- The API base stays `/api` (origin root); the MSW worker registered under `/portfolio-tracker/` controls the page and
  intercepts those requests, so they never reach the network.

## Structure

```
src/
  api/          client.ts (typed fetch + ApiError), hooks.ts (TanStack Query hooks, query keys, invalidation)
  components/   Layout, KpiCard, Change (gain/loss with sign + arrow), Dialog, SegmentedControl, charts/…
  features/     holdings/ (sortable table) · transactions/ (form, CSV import flow, sample CSV)
                portfolios/ (scope hook, header switcher, Manage portfolios dialog)
                usage/ (free-plan usage chip, panel and banner; only where the backend serves GET /usage)
  pages/        Dashboard, Holdings, Dividends, Transactions
  mocks/        fixtures.ts (deterministic demo data), db.ts (in-memory backend), handlers.ts, browser.ts, server.ts
  theme/        ThemeProvider (light/dark, prefers-color-scheme, persisted in localStorage `pt-theme`)
  lib/format.ts the single formatter: Intl number/money formatters (nl-NL, EUR default from DEFAULT_BASE_CURRENCY), hand-built dd-mm-yyyy dates with English month/weekday names, Dutch decimal-input parsing
e2e/            Playwright specs (pages.spec.ts runs only via playwright.pages.config.ts)
e2e-auth/       Cognito-mode specs; e2e-github/ GitHub-mode specs
scripts/        serve-pages.mjs — GitHub-Pages-like static server for the Pages E2E
```

## Multiple portfolios

- The header has a labelled **Portfolio** select ("All portfolios" + every portfolio) and a *Manage portfolios* button.
- The selected scope lives in the URL (`?portfolio=<id>`, or `?portfolio=all` once chosen explicitly), so links and
  the back button work; nav links carry it. Without the param the last choice from localStorage (`pt-portfolio`) is
  used, default all. Unknown/deleted ids fall back to all portfolios (and are never queried).
- Read hooks take the scope and send `?portfolioId=<id>` (omitted for all); query keys are `[resource, scope, …]`.
  Transaction mutations/imports invalidate that portfolio's queries plus the combined ones; deleting a portfolio drops
  its cached queries.
- Manage portfolios (dialog): list with transaction counts, create (name validated with `createPortfolioSchema`,
  API errors such as duplicate names or the portfolio limit shown inline), inline rename (Enter saves, Escape
  cancels), delete with confirmation. `PORTFOLIO_NOT_EMPTY` offers *Delete portfolio and its N transactions*
  (`?force=true`) after typing the portfolio name; `LAST_PORTFOLIO` is explained in plain words.
- Transactions: a *Portfolio* column in the combined list; the add form and CSV import require a target portfolio
  (defaults: the scoped portfolio, else `default`). Page subtitles and empty states name the scope.

## Notes

- All API payload types come from `@portfolio/shared` (`api.ts`, `types.ts`); the transaction form validates with
  `transactionInputSchema`, the import flow with `createImportSchema`.
- Errors use the API envelope `{ error: { code, message, details? } }` and surface as `ApiError` (`status`, `code`). A 429
  `BUDGET_EXHAUSTED` / 503 `BUDGET_UNAVAILABLE` of the Cloudflare free-plan guard becomes a calm "paused, resumes at ..." message (see
  `docs/architecture.md`, "Web: usage indicator").
- After any mutation (create/delete transaction, completed import) the portfolio, holdings, allocation, history,
  dividends and transactions queries of the affected portfolio and of the combined view are invalidated.
- CSV import: `POST /imports` → `PUT uploadUrl` (`Content-Type: text/csv`) → poll `GET /imports/{id}` every 1.5 s
  (max 60 s) until `COMPLETED`/`FAILED`; row-level errors are shown on failure.
- Gains/losses are never conveyed by colour alone: values carry an explicit +/− sign, an arrow and screen-reader text.

## Currency & formatting

- The portfolio base currency is **EUR** (`DEFAULT_BASE_CURRENCY`); every amount is shown in euros first. UI copy is
  English; numbers use the Dutch locale `nl-NL` everywhere (tables, KPIs, chart axes and tooltips):
  `€ 1.234,56`, signed `€ +12,00` / `€ −12,00`, `+12,34%`. Dates are always numeric `dd-mm-yyyy` (`13-10-2026`, with time
  `13-10-2026, 16:39`) and month/weekday names are English (`October 2026`, `Tuesday, 13-10-2026`, axis `Oct 26`),
  independent of the browser locale. All of it lives in `lib/format.ts`.
- Holdings: *Avg cost* and *Price* show `averageCostBase` / `priceBase` (EUR at purchase-date / today's FX); for
  holdings in another currency the trading-currency value (`averageCostLocal` / `priceLocal`) is a muted second line.
  Sorting on these columns uses the EUR values. The sortable *Currency effect* column (`Holding.currencyEffect`) is the
  part of unrealized P&L caused by FX moves since purchase (— for EUR holdings).
- Dashboard: a *Currency effect* KPI (`PortfolioSummary.currencyEffect`), also mentioned under Unrealized P&L.
- Dividends: totals and amounts in EUR; per-share amounts stay in the paying currency.
- Transactions: the form defaults to EUR and, for other currencies, offers an optional **FX rate** (units of the trade
  currency per 1 EUR from the broker statement, e.g. `1.0842` for USD; empty = ECB rate of the trade date), validated by
  `transactionInputSchema`. Number fields accept a Dutch decimal comma (`1,0842`, `1.234,56`). The list shows the
  rate and the EUR equivalent under the total when a rate is present.
- CSV import: optional `fxRate` column (header `date,type,symbol,quantity,price,fee,currency,note,fxRate`, matched
  case-insensitively); CSV numbers use a dot as decimal separator. The sample CSV has one USD row with a rate.
