# @portfolio/web

React SPA for **Portfolio Tracker** — dashboard, holdings, dividends and transactions (incl. CSV import).

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

Mock mode keeps state in memory per page load: adding/deleting transactions and CSV imports recompute holdings,
allocation, history and dividends with the shared calculators in `@portfolio/shared`; a reload resets the demo data.

## Scripts

| Script | What it does |
|---|---|
| `dev` | Vite dev server on :5173 with the `/api` proxy |
| `dev:mock` | Vite in `mock` mode (MSW in the browser) |
| `build` | `tsc -b && vite build` → `dist/` |
| `build:mock` | Production build that runs fully mocked (static demo) |
| `preview` | Serve `dist/` |
| `typecheck` | `tsc -b --noEmit` |
| `lint` | ESLint (typescript-eslint + react-hooks) |
| `test` | Vitest unit/component tests (jsdom + MSW node server) |
| `test:e2e` | Playwright (chromium) against `pnpm dev:mock --port 5174` |

First-time E2E setup: `pnpm --filter @portfolio/web exec playwright install chromium`.

## Environment variables

Build-time (Vite `VITE_*`), see `.env.example`:

| Var | Default | Notes |
|---|---|---|
| `VITE_API_BASE_URL` | `/api` | API base. In AWS set to the API Gateway URL at build time. |
| `VITE_USE_MOCKS` | `false` | `true` enables the MSW browser worker. `--mode mock` (used by `dev:mock`/`build:mock`) implies it. |

## Structure

```
src/
  api/          client.ts (typed fetch + ApiError), hooks.ts (TanStack Query hooks, query keys, invalidation)
  components/   Layout, KpiCard, Change (gain/loss with sign + arrow), Dialog, SegmentedControl, charts/…
  features/     holdings/ (sortable table) · transactions/ (form, CSV import flow, sample CSV)
  pages/        Dashboard, Holdings, Dividends, Transactions
  mocks/        fixtures.ts (deterministic demo data), db.ts (in-memory backend), handlers.ts, browser.ts, server.ts
  theme/        ThemeProvider (light/dark, prefers-color-scheme, persisted in localStorage `pt-theme`)
  lib/format.ts Intl formatters (en-GB locale, currency from the API's baseCurrency)
e2e/            Playwright specs
```

## Notes

- All API payload types come from `@portfolio/shared` (`api.ts`, `types.ts`); the transaction form validates with
  `transactionInputSchema`, the import flow with `createImportSchema`.
- Errors use the API envelope `{ error: { code, message, details? } }` and surface as `ApiError` (`status`, `code`).
- After any mutation (create/delete transaction, completed import) the portfolio, holdings, allocation, history,
  dividends and transactions queries are invalidated.
- CSV import: `POST /imports` → `PUT uploadUrl` (`Content-Type: text/csv`) → poll `GET /imports/{id}` every 1.5 s
  (max 60 s) until `COMPLETED`/`FAILED`; row-level errors are shown on failure.
- Gains/losses are never conveyed by colour alone: values carry an explicit +/− sign, an arrow and screen-reader text.
