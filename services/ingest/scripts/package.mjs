// Zips dist/<name>/ into dist/<name>.zip with index.mjs at the zip root (Lambda handler: index.handler).
import { ZipArchive } from 'archiver';
import { createWriteStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name.split('/').pop();
const srcDir = join(root, 'dist', name);
const zipPath = join(root, 'dist', `${name}.zip`);
if (!existsSync(join(srcDir, 'index.mjs'))) throw new Error(`${srcDir}/index.mjs not found — run build first`);
rmSync(zipPath, { force: true });

await new Promise((resolve, reject) => {
  const out = createWriteStream(zipPath);
  const zip = new ZipArchive({ zlib: { level: 9 } });
  out.on('close', resolve);
  zip.on('error', reject);
  zip.pipe(out);
  // Fixed timestamps keep the zip byte-identical across builds of the same source (stable Terraform hashes).
  const date = new Date('2020-01-01T00:00:00Z');
  for (const f of ['index.mjs', 'index.mjs.map']) zip.file(join(srcDir, f), { name: f, date });
  zip.finalize();
});
console.log(`Packaged ${zipPath} (${statSync(zipPath).size} bytes)`);
