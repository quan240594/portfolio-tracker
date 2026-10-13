# Portfolio Tracker

Personal investment-portfolio analytics: holdings, P&L, allocation, value history, dividends and
CSV imports — built as a full-stack, event-driven AWS serverless reference project.

**Live demo:** <https://quan240594.github.io/portfolio-tracker/> — the SPA running entirely in your browser on sample
data (mocked API, nothing is saved).

| Area | Stack |
|---|---|
| Web | React 18 + TypeScript, Vite, TanStack Query, Recharts, Tailwind, Vitest/RTL/MSW, Playwright |
| API & ingest | Node 22 Lambdas (TypeScript), API Gateway HTTP API, DynamoDB single-table, S3 presigned uploads |
| Market data | Python 3.12 Lambdas — Twelve Data, EODHD, CoinGecko, Alpha Vantage, Frankfurter (ECB FX), or a mock provider |
| Events | S3 → EventBridge → SQS (+DLQ) → ingest; `TransactionsChanged` → SQS → enrichment; Scheduler → price refresh |
| Infra | Terraform (AWS), LocalStack + Docker Compose for local dev, GitHub Actions (CI, deploy via OIDC), SonarCloud |

See [docs/architecture.md](docs/architecture.md) for the architecture diagram and every cross-service contract.
Domain types, API shapes, DynamoDB keys and event schemas live in [packages/shared](packages/shared/src).

## Repository layout

```
packages/shared   domain types, zod schemas, DynamoDB keys, event contract, portfolio calculations
services/api      REST API Lambda (+ local dev server, seed script)
services/ingest   CSV import Lambda (SQS, all-or-nothing, idempotent) (+ local SQS poller)
services/prices   Python market-data Lambdas (scheduled refresh, enrichment of new tickers)
web               React SPA (can run fully mocked)
infra             Terraform + LocalStack bootstrap
```

## Quick start

Prerequisites: Node 22 (20 works locally), pnpm 10, Python 3.12, Docker.

```bash
pnpm install

# UI only, no backend:
pnpm --filter @portfolio/web dev:mock          # http://localhost:5173

# Full local stack:
docker compose up -d --wait                    # LocalStack (set LOCALSTACK_IMAGE=public.ecr.aws/localstack/localstack:3 if Docker Hub is blocked)
pnpm --filter @portfolio/api seed              # demo portfolio, 18 months of prices
pnpm --filter @portfolio/api dev               # API on :3001
pnpm --filter @portfolio/ingest dev            # processes CSV uploads
pnpm --filter @portfolio/web dev               # http://localhost:5173 (proxies /api -> :3001)

# Market data (optional), mock provider:
cd services/prices && python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
MARKET_DATA_PROVIDER=mock .venv/bin/python -m prices.local refresh
```

## Quality

```bash
pnpm -r typecheck && pnpm -r lint && pnpm -r test     # TypeScript
LOCALSTACK=1 pnpm --filter @portfolio/api test:integration
pnpm --filter @portfolio/web test:e2e                 # Playwright
(cd services/prices && .venv/bin/ruff check . && .venv/bin/pytest -q --cov=prices)
scripts/coverage.sh                                   # all coverage reports used by Sonar
```

### SonarCloud

Configured in [sonar-project.properties](sonar-project.properties) (project `quan240594_portfolio-tracker`).

- CI: [.github/workflows/sonarcloud.yml](.github/workflows/sonarcloud.yml) runs on PRs, pushes to `main` and manually; needs repo secret `SONAR_TOKEN`
  (disable *Automatic Analysis* in SonarCloud so the CI-based analysis with coverage is used).
- Local: one-time token setup as described in [scripts/sonar-scan.sh](scripts/sonar-scan.sh), then `scripts/sonar-scan.sh --coverage`.
- Pre-push hook: `git config core.hooksPath .githooks` — every push runs coverage + a Sonar scan on a clean tree
  (`SKIP_SONAR=1 git push` to bypass in an emergency).

## Deploy

See [infra/terraform/README.md](infra/terraform/README.md) (remote state bootstrap, `terraform apply`, API keys in SSM,
web upload) and [.github/workflows/deploy.yml](.github/workflows/deploy.yml) (GitHub OIDC → AWS).

## Deployment (GitHub Pages)

The public demo is deployed by [.github/workflows/pages.yml](.github/workflows/pages.yml).

- **Trigger:** push to `main` touching `web/**`, `packages/shared/**`, `pnpm-lock.yaml` or the workflow itself; or run it
  manually (*Actions → Pages → Run workflow*).
- **Build:** `pnpm --filter @portfolio/web build:pages` — demo mode (`--mode mock`, `VITE_USE_MOCKS=true`, MSW in the
  browser, in-memory sample data that resets on reload) with base path `/portfolio-tracker/`. It never calls a real API.
  The build also writes `404.html` (copy of `index.html`, so deep links like `/portfolio-tracker/holdings` survive a
  refresh) and `.nojekyll`. Then `upload-pages-artifact` (`web/dist`) → `deploy-pages` (environment `github-pages`).
- **One-time setting:** *Settings → Pages → Source: GitHub Actions* (already done).
- **Preview locally:**

  ```bash
  pnpm --filter @portfolio/web build:pages && pnpm --filter @portfolio/web preview:pages   # http://localhost:4173/portfolio-tracker/
  pnpm --filter @portfolio/web test:e2e:pages   # Playwright against the Pages build (Pages-like server with 404.html fallback)
  ```

## Disclaimer

Market data may be delayed. Not investment advice. CoinGecko data requires attribution (shown in the app footer).
