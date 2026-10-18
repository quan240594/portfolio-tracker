/**
 * CPU measurement of the real API handler paths against the in-memory item store.
 *
 *   node --expose-gc --import tsx src/bench/cpu.ts [--quick] [--only heavy|baseline]
 *
 * Per endpoint: probe call (rows/queries/bytes), warm-up, N timed runs (median / p95 / min), and a COLD call in a fresh
 * child process (first call after module load; what a freshly started isolate pays). CPU = process.cpuUsage()
 * (user + system), i.e. V8 CPU time, like the Workers limit (wall time and I/O waits excluded).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_READ_CASES, COMPUTE_CASES } from './endpoints.ts';
import { buildDataset, invoke, setup, SCENARIOS, type Case, type DatasetName, type Scenario } from './harness.ts';

/**
 * Safety factor Node (Apple M-series) -> Cloudflare Worker CPU: x2.0, applied to both warm p95 and the cold call.
 * Why 2: (1) an edge server core runs single-thread JS roughly 1.3-2x slower than an M-series core; (2) Workers
 * isolates are recycled, so a low-traffic personal app sees many cold isolates (cold is reported separately);
 * (3) D1 result hand-over and the Workers runtime's own request overhead are only modelled approximately (`wire`).
 * Offsetting: process.cpuUsage() also counts V8's helper threads (GC, concurrent compile), which the per-isolate
 * Workers CPU clock may not. 2.0 is a judgement call, NOT a measured constant: the limits probe (limits-probe/)
 * exists to calibrate it on a real free account.
 */
export const SAFETY_FACTOR = 2.0;
export const GREEN_MS = 3;
export const AMBER_MS = 8;

export const verdict = (estMs: number): 'GREEN' | 'AMBER' | 'RED' => (estMs <= GREEN_MS ? 'GREEN' : estMs <= AMBER_MS ? 'AMBER' : 'RED');

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, '..', '..', 'results');
const cpuMs = (t0: NodeJS.CpuUsage) => {
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
};
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;

export interface CaseResult {
  id: string;
  status: number;
  queries: number;
  rowsRead: number;
  responseBytes: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  coldMs: number | null;
  estWorkerMs: number;
  estColdMs: number | null;
  verdict: 'GREEN' | 'AMBER' | 'RED';
  coldVerdict: 'GREEN' | 'AMBER' | 'RED' | null;
}

async function coldChild(dataset: DatasetName, scenario: Scenario, c: Case): Promise<number | null> {
  const res = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), '--cold', dataset, scenario.id, c.id], {
    encoding: 'utf8',
    cwd: join(here, '..', '..'),
  });
  const line = res.stdout.split('\n').find((l) => l.startsWith('COLD '));
  return line ? Number(line.slice(5)) : null;
}

async function runDataset(dataset: DatasetName, scenario: Scenario, runs: number, cold: boolean): Promise<CaseResult[]> {
  const ds = await buildDataset(dataset);
  const s = setup(ds, scenario);
  const out: CaseResult[] = [];
  for (const c of ALL_READ_CASES) {
    s.store.resetStats();
    const probe = await invoke(s, c); // also warms nothing important: the stats are what we want
    const stats = { ...s.store.stats };
    for (let i = 0; i < 8; i++) await invoke(s, c);
    (globalThis as { gc?: () => void }).gc?.();
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = process.cpuUsage();
      await invoke(s, c);
      samples.push(cpuMs(t0));
    }
    samples.sort((a, b) => a - b);
    const med = quantile(samples, 0.5);
    const p95 = quantile(samples, 0.95);
    const coldMs = cold ? await coldChild(dataset, scenario, c) : null;
    const est = p95 * SAFETY_FACTOR;
    out.push({
      id: c.id,
      status: probe.status,
      queries: stats.queries,
      rowsRead: stats.rowsRead,
      responseBytes: probe.bytes,
      medianMs: med,
      p95Ms: p95,
      minMs: samples[0]!,
      coldMs,
      estWorkerMs: est,
      estColdMs: coldMs === null ? null : coldMs * SAFETY_FACTOR,
      verdict: verdict(est),
      coldVerdict: coldMs === null ? null : verdict(coldMs * SAFETY_FACTOR),
    });
    process.stdout.write(`  ${dataset}/${scenario.id} ${c.id.padEnd(38)} rows=${String(stats.rowsRead).padStart(6)} med=${med.toFixed(2)} p95=${p95.toFixed(2)} cold=${coldMs?.toFixed(1) ?? '-'}\n`);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--cold') {
    const [, dataset, scenarioId, caseId] = argv as [string, DatasetName, string, string];
    const scenario = SCENARIOS.find((x) => x.id === scenarioId)!;
    const c = COMPUTE_CASES.concat(ALL_READ_CASES).find((x) => x.id === caseId)!;
    const s = setup(await buildDataset(dataset), scenario);
    (globalThis as { gc?: () => void }).gc?.();
    const t0 = process.cpuUsage();
    await invoke(s, c);
    console.log(`COLD ${cpuMs(t0)}`);
    return;
  }
  const quick = argv.includes('--quick');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? (argv[onlyIdx + 1] as DatasetName) : undefined;
  mkdirSync(resultsDir, { recursive: true });
  const nodeTag = `node${process.versions.node.split('.')[0]}`;
  const datasets: DatasetName[] = only ? [only] : ['baseline', 'heavy'];
  const all: Record<string, CaseResult[]> = {};
  for (const dataset of datasets) {
    for (const scenario of SCENARIOS) {
      // cold children only for the layouts we compare in the report, and only on the primary Node version
      const cold = !quick && scenario.id !== 'day-d1';
      all[`${dataset}/${scenario.id}`] = await runDataset(dataset, scenario, dataset === 'heavy' ? 25 : 60, cold);
    }
  }
  const file = join(resultsDir, `cpu-${nodeTag}${quick ? '-quick' : ''}.json`);
  writeFileSync(file, JSON.stringify({ node: process.version, arch: process.arch, safetyFactor: SAFETY_FACTOR, thresholds: { greenMs: GREEN_MS, amberMs: AMBER_MS }, results: all }, null, 2));
  console.log(`wrote ${file}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
