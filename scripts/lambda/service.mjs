// Shared helpers for the Lambda build/package scripts. The service directory is passed as argv[2]
// (relative to the cwd, defaults to the cwd); esbuild/archiver are resolved from that service's own dependencies.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function resolveService(dirArg = '.') {
  const root = resolve(dirArg);
  const name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name.split('/').pop();
  const requireFromService = createRequire(join(root, 'package.json'));
  const importFromService = (pkg) => import(pathToFileURL(requireFromService.resolve(pkg)).href);
  return { root, name, srcDir: join(root, 'dist', name), importFromService };
}
