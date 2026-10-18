# Cloudflare feasibility spike (offline)

Throwaway measurement code behind the section **"Cloudflare personal deployment: feasibility spike"** at the end of
[`docs/architecture.md`](../../../docs/architecture.md). Nothing here is deployed, nothing needs a Cloudflare account, and
it is **not part of the pnpm workspace** (own `package.json` and lockfile; the root lockfile and `pnpm -r` scripts do not
see it). It imports the real route handlers, shared engine, seed and ingest code from the repo (import only, no edits).

```
src/dataset/     baseline.ts (the REAL seed run against a capturing fake client) and heavy.ts (30 holdings, 5 years)
src/store/       item-store.ts (the `items(pk, sk, data)` model), memory-store.ts, sqlite-store.ts (node:sqlite),
                 items-repository.ts (Repository + ManagementRepository on that table, same key scheme as DynamoDB),
                 load-dataset.ts (row-per-day or row-per-symbol-year layout)
src/bench/       cpu.ts (CPU of every compute route), breakdown.ts (decode vs compute), d1-model.ts + jobs.ts (rows
                 read/written, EXPLAIN QUERY PLAN, job costs, daily projection), import-cpu.ts, payload-cpu.ts,
                 hybrid.ts (value-history share per endpoint, materialised series, raw-row payload + browser CPU), report.ts
src/worker/      entry.ts + d1-store.ts (the API on the real D1 binding API), bundle.ts (esbuild report), seed-sql.ts,
                 smoke.sh; wrangler.toml (dry-run + `wrangler dev --local` only)
limits-probe/    Worker + Durable Object + Queue + Cron + D1 to measure the real free-plan limits in ~10 minutes (see its README)
results/         the measured numbers (JSON) the report quotes
```

## Reproduce

Node 20 arm64 for everything except the D1 model (`node:sqlite` needs Node 22+; any Node 22/24 works).

```bash
export PATH=$HOME/.nvm/versions/node/v20.19.0/bin:$PATH
cd platform/cloudflare/spike && npm install        # behind a TLS-inspecting proxy: NODE_EXTRA_CA_CERTS=<pem>

npx tsc --noEmit                                                   # typecheck the spike
node --expose-gc --import tsx src/bench/cpu.ts                     # ~12 min, writes results/cpu-node20.json
node --expose-gc --import tsx src/bench/breakdown.ts               # decode vs compute, chunk sizing
node --expose-gc --import tsx src/bench/import-cpu.ts
node --expose-gc --import tsx src/bench/payload-cpu.ts
node --expose-gc --import tsx src/bench/hybrid.ts                  # results/hybrid-node20.json (payload sizes, a-vs-c numbers)
PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PATH node --import tsx src/bench/d1-model.ts   # results/d1-model.json
npx tsx src/bench/report.ts > results/tables.md

npx tsx src/worker/bundle.ts                                       # bundle size + incompatibility report
npx tsx src/worker/seed-sql.ts heavy                               # .wrangler/seed/seed-heavy.sql
npx wrangler d1 execute DB --local --persist-to .wrangler/state --file .wrangler/seed/seed-heavy.sql
npx wrangler dev --local --persist-to .wrangler/state --port 8799  # then: ./src/worker/smoke.sh
```

`wrangler` is pinned by the spike lockfile (4.86, workerd 2026-04-26): its compatibility date tops out at 2026-05-03.
`wrangler dev --local` runs the real workerd but does **not** enforce `limits.cpu_ms` (checked with `cpu_ms = 10`), so
CPU caps can only be measured on a real account: that is what `limits-probe/` is for.

## What is committed

`results/*.json`, `tables.md` and the two workerd smoke transcripts (all < 90 KB, regenerable with the commands above). Not committed
(`.gitignore`): `node_modules/`, `dist/` (the Workers bundle), `.wrangler/` (seed SQL, local D1 state) and `results/*.log`. The spike is excluded
from Sonar (`sonar-project.properties`), has no ESLint config of its own (`eslint.config.js` ignores everything) and is not in
`pnpm-workspace.yaml`, so `pnpm -r typecheck` / `lint` / `test` never see it; check it on its own with `npm run typecheck` here and in `limits-probe/`.
