// Shared helpers for the Lambda build/package scripts. Services are selected by name from a fixed allowlist, so no
// command-line input is ever used as a filesystem path; esbuild/archiver are resolved from that service's own dependencies.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICES = { api: 'services/api', ingest: 'services/ingest', 'broker-sync': 'services/broker-sync' };

export function resolveService(serviceArg) {
  // Take name and directory from the constant, never from the argument itself.
  const entry = Object.entries(SERVICES).find(([key]) => key === serviceArg);
  if (!entry) {
    throw new Error(`Unknown service "${serviceArg}". Usage: node <script> <${Object.keys(SERVICES).join('|')}>`);
  }
  const [name, relDir] = entry;
  const root = join(REPO_ROOT, relDir);
  const requireFromService = createRequire(join(root, 'package.json'));
  const importFromService = (pkg) => import(pathToFileURL(requireFromService.resolve(pkg)).href);
  return { root, name, srcDir: join(root, 'dist', name), importFromService };
}
