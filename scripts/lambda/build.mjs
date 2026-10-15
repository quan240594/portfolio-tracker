// Bundles a service's Lambda handler to <service>/dist/<name>/index.mjs (ESM, node22). The AWS SDK is bundled to pin its version.
// Usage: node scripts/lambda/build.mjs <api|ingest|broker-sync>
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveService } from './service.mjs';

const { root, srcDir: outdir, importFromService } = resolveService(process.argv[2]);
const { build } = await importFromService('esbuild');
rmSync(outdir, { recursive: true, force: true });

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(outdir, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: false,
  sourcemap: true,
  // Lets bundled CommonJS dependencies call require() inside the ESM output.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});
