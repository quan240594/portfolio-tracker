// Bundles the Lambda handler to dist/<name>/index.mjs (ESM, node22). The AWS SDK is bundled to pin its version.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name.split('/').pop();
const outdir = join(root, 'dist', name);
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
