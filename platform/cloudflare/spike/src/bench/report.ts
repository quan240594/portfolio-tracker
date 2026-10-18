/** Turns results/*.json into the markdown tables of the report.   npx tsx src/bench/report.ts > results/tables.md */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results');
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

interface Case {
  id: string; queries: number; rowsRead: number; responseBytes: number; medianMs: number; p95Ms: number; coldMs: number | null;
  estWorkerMs: number; estColdMs: number | null; verdict: string; coldVerdict: string | null;
}
const cpu = load('cpu-node20.json') as { safetyFactor: number; results: Record<string, Case[]> };
const d1 = load('d1-model.json') as { endpoint: Record<string, { id: string; statements: number; rowsRead: number; rowsWritten: number }[]> };

const f1 = (n: number) => n.toFixed(n < 10 ? 1 : 0);
const num = (n: number) => n.toLocaleString('en');
const dot = (v: string | null) => (v === 'GREEN' ? 'GREEN' : v === 'AMBER' ? 'AMBER' : v === 'RED' ? 'RED' : '-');

function table() {
  const heavyDay = new Map(cpu.results['heavy/day-plain']!.map((c) => [c.id, c]));
  const baseline = new Map(cpu.results['baseline/packed-d1']!.map((c) => [c.id, c]));
  const baselineDay = new Map(cpu.results['baseline/day-plain']!.map((c) => [c.id, c]));
  const lines = [
    `| Endpoint | Rows read, heavy: day layout → packed | D1 stmts | Node CPU ms median / p95, heavy (packed layout + D1 decode) | Cold call ms | **Est. Worker CPU ms** (${cpu.safetyFactor} × p95) | **Verdict** | Baseline demo-size: Node median / p95 (rows read) | Baseline est. ms | Baseline verdict |`,
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const p of cpu.results['heavy/packed-d1']!) {
    const d = heavyDay.get(p.id)!;
    const b = baseline.get(p.id)!;
    const bd = baselineDay.get(p.id)!;
    lines.push(`| ${p.id} | ${num(d.rowsRead)} → ${num(p.rowsRead)} | ${p.queries} | ${f1(p.medianMs)} / ${f1(p.p95Ms)} | ${p.coldMs === null ? '-' : f1(p.coldMs)} | **${f1(p.estWorkerMs)}** | **${dot(p.verdict)}** | ${f1(b.medianMs)} / ${f1(b.p95Ms)} (${num(bd.rowsRead)}) | ${f1(b.estWorkerMs)} | ${dot(b.verdict)} |`);
  }
  return lines.join('\n');
}

console.log(table());
const counts: Record<string, Record<string, number>> = {};
for (const ds of ['heavy', 'baseline'] as const)
  for (const layout of ['day-plain', 'packed-d1'] as const) {
    const c: Record<string, number> = { GREEN: 0, AMBER: 0, RED: 0 };
    for (const r of cpu.results[`${ds}/${layout}`]!) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
    counts[`${ds}/${layout}`] = c;
  }
console.log('\nVerdict counts (warm, 2 x p95):', JSON.stringify(counts));
void d1;
