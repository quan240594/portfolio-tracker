/**
 * Workers bundling report. Bundles the unmodified API handlers + shared engine for workerd with esbuild and reports
 *   A) the naive bundle (what you get without touching services/api): every node:* import and every dependency that
 *      leaks in (AWS SDK, powertools, broker-sync...);
 *   B) the Workers-ready bundle (logger + broker-sync aliased to shims): size, gzip, brotli, and a per-package breakdown;
 *   C) the shared engine alone, and zod alone (the dependency the owner asked about).
 *
 *   npx tsx src/worker/bundle.ts           # writes dist/worker.mjs (B) and results/bundle-report.json
 */
import { build, type Metafile, type Plugin } from 'esbuild';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const spike = resolve(here, '..', '..');
const root = resolve(spike, '..', '..', '..');
const dist = join(spike, 'dist');
const results = join(spike, 'results');
mkdirSync(dist, { recursive: true });
mkdirSync(results, { recursive: true });

const sharedEntry = join(root, 'packages/shared/src/index.ts');
const entry = join(here, 'entry.ts');

/** `@portfolio/shared` resolves through services/api/node_modules (a pnpm workspace link); pin it to the source. */
const aliasShared: Plugin = {
  name: 'alias-shared',
  setup(b) {
    b.onResolve({ filter: /^@portfolio\/shared$/ }, () => ({ path: sharedEntry }));
  },
};
const shims: Plugin = {
  name: 'workers-shims',
  setup(b) {
    b.onResolve({ filter: /\/lib\/logger\.js$/ }, (a) => (a.importer.includes('services/api/src') ? { path: join(here, 'shims/logger.ts') } : undefined));
    b.onResolve({ filter: /^@portfolio\/broker-sync$/ }, () => ({ path: join(here, 'shims/broker-sync.ts') }));
  },
};

const common = {
  bundle: true,
  format: 'esm' as const,
  platform: 'neutral' as const,
  target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['module', 'main'],
  metafile: true,
  write: false,
  logLevel: 'silent' as const,
  external: ['node:*', 'cloudflare:*'],
};

interface Breakdown {
  [pkg: string]: number;
}
function breakdown(meta: Metafile): Breakdown {
  const out: Breakdown = {};
  for (const o of Object.values(meta.outputs)) {
    for (const [file, info] of Object.entries(o.inputs)) {
      const f = file.replaceAll('\\', '/');
      const nm = f.includes('node_modules/') ? /^((?:@[^/]+\/)?[^/]+)\//.exec(f.split('node_modules/').pop()!) : null;
      const key = nm
        ? nm[1]!
        : f.includes('packages/shared')
          ? '@portfolio/shared (src)'
          : f.includes('services/api')
            ? 'services/api (src)'
            : f.includes('spike/src') || f.startsWith('src/')
              ? 'spike adapters (items-repository, d1-store, entry, shims)'
              : f;
      out[key] = (out[key] ?? 0) + info.bytesInOutput;
    }
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 25));
}

function externals(meta: Metafile): string[] {
  const set = new Set<string>();
  for (const o of Object.values(meta.outputs)) for (const i of o.imports) if (i.external) set.add(i.path);
  return [...set].sort();
}

/** Which input file pulled each external module in (first importer). */
function importers(meta: Metafile): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const [file, info] of Object.entries(meta.inputs)) {
    for (const i of info.imports) if (i.external && /^(node|cloudflare):/.test(i.path)) (out[i.path] ??= new Set()).add(file.replace(/^.*node_modules\/\.pnpm\//, ''));
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].slice(0, 4)]));
}

/** Constructs that the Workers runtime rejects or that signal Node-only code. */
const scan = (code: string) =>
  Object.fromEntries(
    Object.entries({
      'new Function(': /new Function\(/g,
      'eval(': /\beval\(/g,
      'require(': /\brequire\(/g,
      'process.': /\bprocess\.(env|versions|nextTick|platform)/g,
      Buffer: /\bBuffer\b/g,
      'node: imports': /from ["']node:/g,
      __dirname: /__dirname/g,
    }).map(([k, re]) => [k, (code.match(re) ?? []).length]),
  );

const sizes = (code: string) => ({ bytes: Buffer.byteLength(code), gzip: gzipSync(code).length, brotli: brotliCompressSync(code).length });

async function attempt(name: string, opts: Parameters<typeof build>[0]) {
  try {
    const res = await build({ ...common, ...opts } as never);
    const code = res.outputFiles?.[0]?.text ?? '';
    return { name, ok: true as const, code, meta: res.metafile!, errors: [] as string[], warnings: res.warnings.map((w) => w.text) };
  } catch (err) {
    const e = err as { errors?: { text: string; location?: { file: string } }[] };
    return { name, ok: false as const, code: '', meta: undefined, errors: (e.errors ?? []).map((x) => `${x.text}${x.location ? ` (${x.location.file})` : ''}`), warnings: [] as string[] };
  }
}

const out = join(dist, 'out.mjs');

// A) naive: only the shared alias (needed because the pnpm workspace link is not visible from the spike folder)
const naive = await attempt('A: naive (no shims)', { entryPoints: [entry], outfile: out, plugins: [aliasShared], minify: false });
// B) Workers-ready
const ready = await attempt('B: Workers-ready (logger + broker-sync shims)', { entryPoints: [entry], outfile: out, plugins: [aliasShared, shims], minify: false });
const readyMin = await attempt('B min', { entryPoints: [entry], outfile: out, plugins: [aliasShared, shims], minify: true });
// C) pieces
const sharedOnly = await attempt('C1: packages/shared alone (min)', { entryPoints: [sharedEntry], outfile: out, plugins: [aliasShared], minify: true });
const zodOnly = await attempt('C2: zod alone (min)', {
  stdin: { contents: `import { z } from 'zod'; export default z.object({ a: z.string() });`, resolveDir: join(root, 'packages/shared'), loader: 'ts' },
  outfile: out,
  minify: true,
});

if (readyMin.ok) writeFileSync(join(dist, 'worker.mjs'), readyMin.code);

const report = {
  generatedAt: new Date().toISOString(),
  esbuild: JSON.parse(readFileSync(join(spike, 'node_modules/esbuild/package.json'), 'utf8')).version as string,
  naive: {
    ok: naive.ok,
    errors: naive.errors.slice(0, 20),
    externalNodeModules: naive.meta ? externals(naive.meta) : [],
    importers: naive.meta ? importers(naive.meta) : {},
    size: naive.ok ? sizes(naive.code) : null,
    scan: naive.ok ? scan(naive.code) : null,
    breakdownBytes: naive.meta ? breakdown(naive.meta) : {},
  },
  workersReady: {
    ok: ready.ok,
    errors: ready.errors,
    externalNodeModules: ready.meta ? externals(ready.meta) : [],
    sizeUnminified: ready.ok ? sizes(ready.code) : null,
    sizeMinified: readyMin.ok ? sizes(readyMin.code) : null,
    scan: ready.ok ? scan(ready.code) : null,
    breakdownBytesMinified: readyMin.meta ? breakdown(readyMin.meta) : {},
  },
  sharedEngineOnly: sharedOnly.ok ? sizes(sharedOnly.code) : null,
  zodOnly: zodOnly.ok ? sizes(zodOnly.code) : null,
};
writeFileSync(join(results, 'bundle-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
