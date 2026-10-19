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
packages/platform platform ports (ItemStore, SecretStore, JobQueue, FileStore, ...), in-memory fakes, contract test suites
packages/aws      the AWS adapters of the ports (DynamoDB, Secrets Manager, EventBridge, S3, Lambda)
packages/cloudflare the Cloudflare adapters of the ports on a SQLite Durable Object (items, encrypted secrets, files, alarm job queue)

packages/prices   TypeScript port of the price service (providers and resumable price jobs on the ports; the Python service stays for AWS)
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

- CI: all jobs in [.github/workflows/ci.yml](.github/workflows/ci.yml) start immediately and run in parallel. The `sonar` job
  waits only for the two jobs that produce its coverage reports (Node tests and Python) and analyses that coverage
  (nothing is re-run) while typecheck/lint, build, integration, e2e and terraform are still running. It runs on PRs (except forks, which
  get no secrets), pushes to `main` and manual runs; needs repo secret `SONAR_TOKEN`
  (keep *Automatic Analysis* disabled in SonarCloud so the CI-based analysis with coverage is used).
  Deploy ([deploy.yml](.github/workflows/deploy.yml)) is a separate manual workflow and does not depend on CI or Sonar.
- Local: one-time token setup as described in [scripts/sonar-scan.sh](scripts/sonar-scan.sh), then `scripts/sonar-scan.sh --coverage`.
- Pre-push hook: `git config core.hooksPath .githooks` — every push runs coverage + a Sonar scan on a clean tree
  (`SKIP_SONAR=1 git push` to bypass in an emergency).

## Deploy

See [infra/terraform/README.md](infra/terraform/README.md) (remote state bootstrap, `terraform apply`, API keys in SSM,
web upload) and [.github/workflows/deploy.yml](.github/workflows/deploy.yml) (GitHub OIDC → AWS).

### Sign-in (Cognito + TOTP)

Deployed environments require a login: Amazon Cognito, admin-created users only, authenticator-app (TOTP) MFA
mandatory. Local dev and the GitHub Pages demo run without login. After `terraform apply`, create your user
(see [infra/terraform/README.md](infra/terraform/README.md#8-users-and-sign-in-cognito)):

```bash
aws cognito-idp admin-create-user --user-pool-id "$(terraform -chdir=infra/terraform output -raw cognito_user_pool_id)" \
  --username you@example.com --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --temporary-password '<temporary password>' --message-action SUPPRESS
```

First sign-in: temporary password → choose a new password → scan the QR code with an authenticator app → enter the code.

## Deployment (GitHub Pages)

The public demo is deployed by [.github/workflows/pages.yml](.github/workflows/pages.yml).

- **Trigger:** push to `main` touching `web/**`, `packages/shared/**`, `pnpm-lock.yaml` or the workflow itself; or run it
  manually (*Actions → Pages → Run workflow*).
- **Build:** `pnpm --filter @portfolio/web build:pages` — demo mode (`--mode mock`, `VITE_USE_MOCKS=true`, MSW in the
  browser, in-memory sample data that resets on reload) with base path `/portfolio-tracker/`. It never calls a real API.
  The build also writes `404.html` (copy of `index.html`, so deep links like `/portfolio-tracker/holdings` survive a
  refresh) and `.nojekyll`. Then `upload-pages-artifact` (`web/dist`) → `deploy-pages` (environment `github-pages`).
- **Switch to real data:** the demo banner has a "Switch to real data" button. Optionally set the repository *variable*
  (not a secret) `REAL_APP_URL` (*Settings → Secrets and variables → Actions → Variables*) to the `web_url` of your own
  deployment (https only) and re-run the workflow: the button then links there. Unset, it opens a dialog explaining the steps.
- **One-time setting:** *Settings → Pages → Source: GitHub Actions* (already done).
- **Preview locally:**

  ```bash
  pnpm --filter @portfolio/web build:pages && pnpm --filter @portfolio/web preview:pages   # http://localhost:4173/portfolio-tracker/
  pnpm --filter @portfolio/web test:e2e:pages   # Playwright against the Pages build (Pages-like server with 404.html fallback)
  ```

## Disclaimer

Market data may be delayed. Not investment advice. CoinGecko data requires attribution (shown in the app footer).
