/**
 * Free-plan limits probe. Time is frozen inside a Worker (Date.now()/performance.now() only advance after I/O), so
 * "burn N ms" cannot be a deadline loop: it runs a FIXED amount of work, ITERS_PER_MS iterations per requested ms.
 * ITERS_PER_MS was calibrated on the spike author's Apple-silicon Mac with Node 20 (scripts/calibrate.mjs: ~550k/ms
 * measured, 500k used). The REAL CPU time of a call comes from the platform: `npx wrangler tail --format json`
 * (cpuTime / wallTime per invocation) or Workers Logs in the dashboard. The README explains how to turn that into the
 * effective cap per entry point (HTTP, Durable Object fetch, DO alarm, Queue consumer, Cron).
 */
import { DurableObject } from 'cloudflare:workers';

const ITERS_PER_MS = 500_000;

export interface Env {
  PROBE: DurableObjectNamespace<Probe>;
  DB: D1Database;
  QUEUE: Queue<{ id: string; ms: number }>;
}

/** Deterministic CPU work (xorshift). Returns a value so the loop cannot be optimised away. */
function burn(ms: number): number {
  const iters = Math.round(ms * ITERS_PER_MS);
  let x = 123456789;
  let acc = 0;
  for (let i = 0; i < iters; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    acc = (acc + (x & 0xff)) | 0;
  }
  return acc;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const num = (url: URL, name: string, dflt: number, max: number) => Math.min(max, Math.max(0, Number(url.searchParams.get(name) ?? dflt) || dflt));
const ledger = (env: Env) => env.PROBE.get(env.PROBE.idFromName('ledger'));
const burner = (env: Env) => env.PROBE.get(env.PROBE.idFromName('burner'));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/':
        return new Response(
          [
            'limits probe: /burn?ms=N  /subrequests?n=N  /d1-queries?n=N  /d1-batch?n=N  /d1-write?n=N',
            '/do-burn?ms=N  /do-alarm-burn?ms=N  /queue-burn?ms=N  /cron-set?ms=N  /results  /reset',
          ].join('\n'),
        );
      case '/burn': {
        const ms = num(url, 'ms', 1, 60_000);
        const check = burn(ms);
        return json({ kind: 'worker-http', requestedMs: ms, iterations: Math.round(ms * ITERS_PER_MS), check });
      }
      case '/subrequests': {
        // Sequential on purpose: the Free plan caps subrequests per invocation at 50 (and 6 simultaneous connections).
        const n = num(url, 'n', 10, 1000);
        let ok = 0;
        let firstError: string | null = null;
        for (let i = 0; i < n; i++) {
          try {
            const r = await fetch('https://cloudflare.com/cdn-cgi/trace');
            await r.text();
            ok++;
          } catch (e) {
            firstError = (e as Error).message;
            break;
          }
        }
        return json({ kind: 'subrequests', requested: n, succeeded: ok, firstError });
      }
      case '/d1-queries': {
        // n separate prepared statements, one round trip each: where does the 50-queries-per-invocation cap bite?
        const n = num(url, 'n', 10, 1000);
        let ok = 0;
        let firstError: string | null = null;
        for (let i = 0; i < n; i++) {
          try {
            await env.DB.prepare('SELECT ?1 AS i').bind(i).first();
            ok++;
          } catch (e) {
            firstError = (e as Error).message;
            break;
          }
        }
        return json({ kind: 'd1-queries', requested: n, succeeded: ok, firstError });
      }
      case '/d1-batch': {
        // ONE db.batch() with n statements: does it count as 1 subrequest or n? (decides how jobs may batch)
        const n = num(url, 'n', 10, 1000);
        try {
          const res = await env.DB.batch(Array.from({ length: n }, (_, i) => env.DB.prepare('SELECT ?1 AS i').bind(i)));
          return json({ kind: 'd1-batch', requested: n, succeeded: res.length });
        } catch (e) {
          return json({ kind: 'd1-batch', requested: n, succeeded: 0, error: (e as Error).message }, 500);
        }
      }
      case '/d1-write': {
        const n = num(url, 'n', 10, 5000);
        await env.DB.exec('CREATE TABLE IF NOT EXISTS probe_rows (id INTEGER PRIMARY KEY, v TEXT)');
        const stmts: D1PreparedStatement[] = [];
        for (let i = 0; i < n; i += 33) {
          const part = Math.min(33, n - i);
          const sql = `INSERT OR REPLACE INTO probe_rows (id, v) VALUES ${Array.from({ length: part }, () => '(?,?)').join(',')}`;
          stmts.push(env.DB.prepare(sql).bind(...Array.from({ length: part }, (_, j) => [i + j, 'x']).flat()));
        }
        try {
          const res = await env.DB.batch(stmts);
          const meta = res.map((r) => r.meta);
          return json({ kind: 'd1-write', requestedRows: n, statements: stmts.length, rowsWritten: meta.reduce((s, m) => s + (m.rows_written ?? 0), 0), rowsRead: meta.reduce((s, m) => s + (m.rows_read ?? 0), 0) });
        } catch (e) {
          return json({ kind: 'd1-write', requestedRows: n, error: (e as Error).message }, 500);
        }
      }
      case '/do-burn': {
        const ms = num(url, 'ms', 1, 60_000);
        try {
          return await burner(env).fetch(`https://do/burn?ms=${ms}`);
        } catch (e) {
          return json({ kind: 'do-http', requestedMs: ms, error: (e as Error).message }, 500);
        }
      }
      case '/do-alarm-burn': {
        const ms = num(url, 'ms', 1, 60_000);
        return await burner(env).fetch(`https://do/alarm?ms=${ms}`);
      }
      case '/queue-burn': {
        const ms = num(url, 'ms', 1, 60_000);
        const id = `q-${Date.now()}-${ms}`;
        await ledger(env).fetch(`https://do/start?kind=queue&ms=${ms}&id=${id}`);
        await env.QUEUE.send({ id, ms });
        return json({ kind: 'queue-burn', queued: true, id, requestedMs: ms, note: 'see /results; an entry without `finished` was killed' });
      }
      case '/cron-set': {
        const ms = num(url, 'ms', 1, 60_000);
        await ledger(env).fetch(`https://do/cron-ms?ms=${ms}`);
        return json({ kind: 'cron-set', ms, note: 'the next */5 minute tick burns this amount; see /results' });
      }
      case '/results': {
        // queue/cron results are written to the `ledger` object, alarm results to the `burner` object that ran them
        const parts = await Promise.all([ledger(env), burner(env)].map(async (o) => ((await (await o.fetch('https://do/results')).json()) as { rows: object[] }).rows));
        const rows = (parts.flat() as { started: string }[]).sort((a, b) => b.started.localeCompare(a.started));
        return json({ rows });
      }
      case '/reset':
        await Promise.all([ledger(env).fetch('https://do/reset'), burner(env).fetch('https://do/reset')]);
        return json({ ok: true });
      default:
        return new Response('not found', { status: 404 });
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const msg of batch.messages as Message<{ id: string; ms: number }>[]) {
      burn(msg.body.ms);
      await ledger(env).fetch(`https://do/finish?id=${msg.body.id}`);
      msg.ack();
    }
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const res = await ledger(env).fetch('https://do/cron-ms');
    const { ms } = (await res.json()) as { ms: number };
    const id = `cron-${Date.now()}-${ms}`;
    await ledger(env).fetch(`https://do/start?kind=cron&ms=${ms}&id=${id}`);
    burn(ms);
    await ledger(env).fetch(`https://do/finish?id=${id}`);
  },
} satisfies ExportedHandler<Env>;

/** One class, three jobs: CPU burner (HTTP + alarm) and the results ledger. Results live in its SQLite storage. */
export class Probe extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, kind TEXT, ms REAL, started TEXT, finished TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
  }

  private record(kind: string, ms: number, id: string): void {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO ledger (id, kind, ms, started, finished) VALUES (?, ?, ?, ?, NULL)', id, kind, ms, new Date().toISOString());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ms = Number(url.searchParams.get('ms') ?? 1);
    switch (url.pathname) {
      case '/burn': {
        const check = burn(ms);
        return json({ kind: 'do-http', requestedMs: ms, iterations: Math.round(ms * ITERS_PER_MS), check });
      }
      case '/alarm': {
        const id = `alarm-${Date.now()}-${ms}`;
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', 'alarm', JSON.stringify({ id, ms }));
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        this.record('do-alarm', ms, id);
        return json({ kind: 'do-alarm', scheduled: true, id, requestedMs: ms, note: 'fires in ~1 s; see /results: an entry without `finished` was killed' });
      }
      case '/start':
        this.record(url.searchParams.get('kind') ?? '?', ms, url.searchParams.get('id') ?? crypto.randomUUID());
        return json({ ok: true });
      case '/finish':
        this.ctx.storage.sql.exec('UPDATE ledger SET finished = ? WHERE id = ?', new Date().toISOString(), url.searchParams.get('id'));
        return json({ ok: true });
      case '/cron-ms': {
        if (url.searchParams.has('ms')) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', 'cron', String(ms));
        const row = this.ctx.storage.sql.exec('SELECT v FROM kv WHERE k = ?', 'cron').toArray()[0] as { v: string } | undefined;
        return json({ ms: Number(row?.v ?? 1) });
      }
      case '/results': {
        const rows = this.ctx.storage.sql.exec('SELECT id, kind, ms, started, finished FROM ledger ORDER BY started DESC LIMIT 100').toArray();
        return json({ rows: rows.map((r) => ({ ...r, verdict: r.finished ? 'completed' : 'NO FINISH (killed, still running or not yet fired)' })) });
      }
      case '/reset':
        this.ctx.storage.sql.exec('DELETE FROM ledger');
        return json({ ok: true });
      default:
        return new Response('not found', { status: 404 });
    }
  }

  async alarm(): Promise<void> {
    const row = this.ctx.storage.sql.exec('SELECT v FROM kv WHERE k = ?', 'alarm').toArray()[0] as { v: string } | undefined;
    if (!row) return;
    const { id, ms } = JSON.parse(row.v) as { id: string; ms: number };
    burn(ms);
    this.ctx.storage.sql.exec('UPDATE ledger SET finished = ? WHERE id = ?', new Date().toISOString(), id);
  }
}
