# Cloudflare limits probe (free plan, about 10 minutes of your time)

A tiny Worker + SQLite Durable Object + Queue consumer + Cron Trigger + one D1 database that **measures the effective
free-plan limits on a real account**, before any of the app is ported. It answers the open questions of the feasibility
spike in [`docs/architecture.md`](../../../../docs/architecture.md) ("Cloudflare personal deployment: feasibility spike").

**It cannot cost money.** It uses only Free-plan features (Worker, SQLite-backed Durable Object, D1, Queues, one Cron
Trigger, Workers Logs), no `[limits]` block, no routes, no R2 / KV / Hyperdrive / Vectorize / Containers / Zero Trust,
and it needs **no payment method**. On the Free plan a call over a cap just fails (Error 1102 for CPU, 1027 for
requests); nothing is billed unless you yourself upgrade to Workers Paid, which this probe never asks for. It holds
**no secrets and no personal data** (the only outbound call is to `https://cloudflare.com/cdn-cgi/trace`). The probe
URLs are unauthenticated: anybody who learns the URL can burn your daily request quota (never money), so do not publish it
and delete the probe when done.

| Question (the open points of the spike) | Probe |
|---|---|
| Is the CPU cap of a Worker HTTP request really 10 ms? How much work fits? | `/burn?ms=N` |
| Does a **Durable Object** request get the 30 s the DO docs mention, or the 10 ms of the Workers docs? | `/do-burn?ms=N` |
| Same for a DO **alarm** handler | `/do-alarm-burn?ms=N` |
| Same for a **Queue consumer** (the docs say 30 s default, the Free plan 10 ms) | `/queue-burn?ms=N` |
| Same for a **Cron Trigger** | `/cron-set?ms=N` (fires on the next `*/5` tick) |
| Do D1 queries count as subrequests (50/invocation)? Does one `db.batch()` of N statements count as 1 or N? | `/d1-queries?n=N`, `/d1-batch?n=N` |
| Real `rows_written` of multi-row inserts | `/d1-write?n=N` |
| 50 subrequests per invocation | `/subrequests?n=N` |

## Why "nominal ms"?

Inside a Worker `Date.now()` and `performance.now()` are frozen (they only advance after I/O), so a probe cannot "burn
until a deadline". Every `burn(ms)` runs a **fixed amount of work**: `ms x 500,000` xorshift iterations (about 1 ms of
CPU on the author's Apple-silicon Mac with Node 20; `npm run calibrate` prints the number for your machine). The platform
reports the *real* CPU time of each call (step 5), which converts nominal ms into effective CPU ms.

## Steps

1. **Check the account is on the Free plan with no card** (1 min). You are already logged in with wrangler on this Mac:
   `npx wrangler whoami` shows the account. In the dashboard open *Billing*: there must be no Workers Paid subscription
   and no payment method. Do not click *Upgrade* anywhere.
2. **Install** (1 min):

   ```bash
   cd platform/cloudflare/spike/limits-probe
   npm install     # behind a TLS-inspecting proxy: NODE_EXTRA_CA_CERTS=<pem exported from the keychain>
   ```

3. **Create the Queue and the D1 database, then deploy** (2 min). The **first deploy asks you to register a `workers.dev`
   subdomain. It is public in every URL (`https://pt-limits-probe.<subdomain>.workers.dev`) and in certificate
   transparency logs, so choose a neutral name that does not identify you** (random words, no name, employer or handle).

   ```bash
   npx wrangler queues create pt-limits-probe
   npx wrangler d1 create pt-limits-probe          # answer "yes" to let wrangler add the database_id to wrangler.toml
   npx wrangler deploy
   export BASE=https://pt-limits-probe.<your-subdomain>.workers.dev
   curl "$BASE/"                                   # prints the endpoint list
   ```

   * If the deploy rejects the queue bindings on your account, delete the `[[queues.*]]` blocks (and `/queue-burn`) and
     report that as a finding. The Cron Trigger uses 1 of the 5 the Free plan allows.
   * `npx wrangler deploy --dry-run` validates the configuration offline (it passes without an account).

4. **Find the cap of each entry point** (3 min): doubles `ms`, then bisects, and appends every attempt to `results.csv`.

   ```bash
   ./scripts/run-all.sh          # runs 4a-4d and the D1/subrequest checks of step 6; writes results.csv and summary.txt
   ```

   or one entry point at a time (each attempt costs one of the 100,000 free daily requests, nothing else):

   ```bash
   ./scripts/find-cap.sh /burn                 # 4a Worker HTTP request
   ./scripts/find-cap.sh /do-burn              # 4b Durable Object request
   ./scripts/find-cap.sh /do-alarm-burn alarm  # 4c Durable Object alarm (async, result read from /results)
   ./scripts/find-cap.sh /queue-burn async     # 4d Queue consumer (async)
   ```

   A failed HTTP attempt is a non-200 answer: Cloudflare returns **Error 1102 "Worker exceeded resource limits"**
   (normally HTTP 503). `find-cap.sh` records it as `exceeded` in `results.csv` (columns: timestamp, endpoint, requested
   ms, HTTP status, verdict); a body containing `1102` counts too. The Durable Object path may surface as HTTP 500 with an
   "exceeded CPU" message: also `exceeded`. An async attempt (alarm, queue) whose ledger row never gets a `finished` time
   was killed. Expect `/burn` to stop somewhere around 10 nominal ms if the documented Workers Free cap holds.
   A Durable Object alarm that throws is retried automatically (documented: up to 6 times, exponential backoff): a few
   extra rows in `/results` after a kill are normal. `MAX=64 ./scripts/find-cap.sh /do-burn` lowers the upper bound of the search.

5. **Convert nominal ms to real CPU ms** (2 min). In a second terminal:

   ```bash
   npm run tail            # wrangler tail --format json
   ```

   then, in the first one, `curl "$BASE/burn?ms=4"; curl "$BASE/burn?ms=8"; curl "$BASE/do-burn?ms=4"`. Each invocation
   event carries `cpuTime` and `wallTime` (field names can vary by wrangler version; the same numbers are in the dashboard
   under *Workers & Pages > pt-limits-probe > Logs / Observability*). `factor = cpuTime / nominal ms`; the **effective cap in
   real CPU ms = (largest surviving nominal ms) x factor**. Repeat for the DO alarm and the queue consumer (their events
   appear in the tail as well).

6. **Cron, subrequests and D1** (5 min of waiting, mostly idle):

   ```bash
   curl "$BASE/cron-set?ms=5"      # the next */5 tick burns 5 nominal ms; wait for it, then:
   curl "$BASE/results"            # an entry without `finished` was killed; repeat with ms=8, 12, 50
   curl "$BASE/subrequests?n=60"   # expect: succeeded 50, then an error ("Too many subrequests")  (run-all.sh does these 4)
   curl "$BASE/d1-queries?n=60"    # 60 separate D1 statements: where does the 50/invocation cap bite?
   curl "$BASE/d1-batch?n=120"     # ONE batch of 120 statements: does it count as 1 subrequest or as 120?
   curl "$BASE/d1-write?n=2000"    # 61 multi-row statements; compare rowsWritten with the 2000 requested rows
   ```

7. **Record the results** in the table below, keep `results.csv` and `summary.txt`, and send them back. The spike report
   has a "what must be measured on a real account" list that these numbers close.

| Entry point | Largest surviving nominal ms | Real CPU ms (from tail) | Error seen |
|---|---|---|---|
| Worker HTTP | | | |
| Durable Object request | | | |
| Durable Object alarm | | | |
| Queue consumer | | | |
| Cron Trigger | | | |
| D1 queries per invocation (separate statements) | | n/a | |
| D1 `batch()` of N statements | | n/a | |
| Subrequests per invocation | | n/a | |

### How the answer is used (decision rule of the spike report)

* **Durable Object request: real CPU cap >= 500 ms** -> a SQLite Durable Object can serve the heavy analytics server-side
  (option b). **Below that**, the browser computes them (option c, the default plan). Either way the Worker serves cheap
  reads.
* **Queue consumer / cron / alarm: real cap of about 10 ms** -> every background job is chunked to <= 3 ms of CPU per
  invocation (already the design). A larger cap only makes the chunks bigger.
* **D1 `batch()` counts as 1 subrequest** -> a job step may send all the statements it needs in one batch;
  **counts as N** -> at most about 45 statements per invocation (the packed price layout needs far fewer).

## Optional, and the most valuable measurement: the real handlers on the real runtime

The probe above measures a synthetic loop. The spike also contains the **real API handlers on D1** (`../src/worker`).
Deployed to the same free account it tells us, per endpoint, the real Worker CPU including cold starts and D1 result
decoding, which replaces the "x2.0 safety factor" guess of the report with a measurement. It serves **synthetic data
only** (generated by the spike), has no auth (delete it afterwards), and costs nothing.

```bash
cd platform/cloudflare/spike                       # (the folder above this one)
npx tsx src/worker/bundle.ts                       # dist/worker.mjs (Workers-ready bundle, ~190 KB)
npx tsx src/worker/seed-sql.ts heavy               # .wrangler/seed/seed-heavy.sql (2,448 rows = ~2.5% of one day of D1 writes)
npx wrangler d1 create portfolio-tracker-spike     # paste the printed database_id into wrangler.toml
npx wrangler d1 execute portfolio-tracker-spike --remote --file .wrangler/seed/seed-heavy.sql
npx wrangler deploy                                # workers.dev only
npx wrangler tail --format json                    # second terminal: read cpuTime per request
BASE=https://portfolio-tracker-spike.<your-subdomain>.workers.dev ./src/worker/smoke.sh    # statuses + D1 rows read
```

Call each endpoint twice (cold, then warm) and compare `cpuTime` with the Node numbers of the report. HTTP 503 / Error
1102 means "over the CPU cap" and is itself the answer. Clean up with `npx wrangler delete` and
`npx wrangler d1 delete portfolio-tracker-spike`.

## Clean up (leave nothing behind, 3 min)

A Worker whose code still ships a Durable Object class cannot have that class deleted, so the clean-up first deploys a
stub Worker without the class (`wrangler.teardown.toml`: no bindings, no queue consumer, no cron, migration
`deleted_classes = ["Probe"]`), then deletes everything else:

```bash
# 1. delete the Durable Object namespace and its data (permanent, nothing to keep), the cron and the queue consumer
npx wrangler deploy -c wrangler.teardown.toml
# 2. delete the Worker itself, the queue and the D1 database
npx wrangler delete --name pt-limits-probe
npx wrangler queues delete pt-limits-probe
npx wrangler d1 delete pt-limits-probe
# 3. (optional) forget the login on this machine
npx wrangler logout
```

If wrangler rejects the `migrations` deletion (newer wrangler versions prefer the declarative `exports` tombstone), follow
<https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#delete-a-durable-object-class>.
Also delete the real-handler Worker and database if you deployed the optional step above
(`npx wrangler delete` + `npx wrangler d1 delete portfolio-tracker-spike` in the spike folder).

Then **confirm in the dashboard** that nothing is left and nothing was billed:

* *Workers & Pages*: no `pt-limits-probe` (nor `portfolio-tracker-spike`); *Durable Objects*: no namespace; *Storage &
  Databases > D1*: no database; *Queues*: no queue; the Cron Trigger disappears with the Worker.
* *Billing*: no Workers Paid subscription, no payment method, no invoice. *Analytics*: the day's requests stay far below
  100,000.
* The `workers.dev` subdomain stays reserved on the account; that is harmless.
* Daily limits reset at 00:00 UTC, so a failed or interrupted run can simply be repeated tomorrow.
