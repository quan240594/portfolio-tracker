/** Indicative JS heap needed per request (Workers Free: 128 MB per isolate).  node --expose-gc --import tsx src/bench/memory.ts */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, buildDataset, invoke, SCENARIOS } from './harness.ts';
import { COMPUTE_CASES } from './endpoints.ts';

const gc = (globalThis as { gc?: () => void }).gc!;
const ds = await buildDataset('heavy');
const out: Record<string, Record<string, number>> = {};
for (const scenarioId of ['day-plain', 'packed-d1']) {
  const s = setup(ds, SCENARIOS.find((x) => x.id === scenarioId)!);
  const res: Record<string, number> = {};
  for (const c of COMPUTE_CASES) {
    await invoke(s, c);
    gc();
    const h0 = process.memoryUsage().heapUsed;
    let peak = 0;
    // sample the heap from a timer-less loop: allocate-heavy calls reach their peak before the next gc, so also use the final delta
    await invoke(s, c);
    peak = process.memoryUsage().heapUsed - h0;
    res[c.id] = Math.round(peak / 1024 / 1024 * 10) / 10;
  }
  out[scenarioId] = res;
}
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'memory-node20.json'), JSON.stringify({ unit: 'MB heap allocated during one call (upper bound of live set)', ...out }, null, 2));
const max = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, 4);
console.log('day-plain top', max(out['day-plain']!), '\npacked-d1 top', max(out['packed-d1']!));
