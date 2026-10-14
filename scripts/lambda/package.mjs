// Zips <service>/dist/<name>/ into <service>/dist/<name>.zip with index.mjs at the zip root (Lambda handler: index.handler).
// Usage: node scripts/lambda/package.mjs <api|ingest>
import { createWriteStream, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveService } from './service.mjs';

const { root, name, srcDir, importFromService } = resolveService(process.argv[2]);
const { ZipArchive } = await importFromService('archiver');
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
