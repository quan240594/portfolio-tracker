import { buildBaseline } from './baseline.ts';
import { buildHeavy } from './heavy.ts';

const base = await buildBaseline();
const t0 = Date.now();
const heavy = buildHeavy();
console.log('baseline', base.items.length, JSON.stringify(base.counts));
console.log('heavy', heavy.items.length, `(${Date.now() - t0} ms)`, JSON.stringify(heavy.counts));
const bytes = (d: typeof heavy) => d.items.reduce((s, i) => s + JSON.stringify(i).length, 0);
console.log('bytes baseline', bytes(base), 'heavy', bytes(heavy));
