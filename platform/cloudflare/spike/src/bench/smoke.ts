import { ALL_READ_CASES, WRITE_CASES } from './endpoints.ts';
import { buildDataset, invoke, setup, SCENARIOS, type DatasetName } from './harness.ts';

const name = (process.argv[2] ?? 'heavy') as DatasetName;
const ds = await buildDataset(name);
const s = setup(ds, SCENARIOS[0]!);
for (const c of [...ALL_READ_CASES, ...WRITE_CASES]) {
  s.store.resetStats();
  const t = process.cpuUsage();
  try {
    const r = await invoke(s, c);
    const cpu = process.cpuUsage(t);
    console.log(c.id.padEnd(40), r.status, String(r.bytes).padStart(9), `q=${s.store.stats.queries} r=${s.store.stats.rowsRead} w=${s.store.stats.rowsWritten}`, `${((cpu.user + cpu.system) / 1000).toFixed(1)}ms`);
  } catch (e) {
    console.log(c.id.padEnd(40), 'ERR', (e as Error).message.slice(0, 120));
  }
}
