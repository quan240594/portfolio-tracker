import { T212_ENVIRONMENTS, trimTrailingSlashes, type Trading212Credentials } from '@portfolio/shared';
import { BrokerError } from './errors.js';
import type { CredentialSource } from './credentials.js';

const ENV_FILE_NAME = '.env.trading212.local';

export interface LocalCredentialDeps {
  env: NodeJS.ProcessEnv;
  /** Returns the file content, or undefined when the file does not exist. */
  readFile: (path: string) => string | undefined;
  /** Directory to search upwards for the default `.env.trading212.local` (the repo root). */
  cwd: string;
  fileExists: (path: string) => boolean;
}

/** `KEY=value` lines; `#` comments and surrounding quotes are ignored. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_]\w*)\s*=/.exec(line);
    if (!match) continue;
    const value = line.slice(match[0].length).trim();
    // Only trailing/leading whitespace may contain line terminators; a value that still has one is not a valid line.
    if (/[\r\u2028\u2029]/.test(value)) continue;
    out[match[1]!] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** The file named by T212_ENV_FILE, else the nearest `.env.trading212.local` in the cwd or its parents. */
function locateEnvFile(deps: LocalCredentialDeps): string | undefined {
  if (deps.env.T212_ENV_FILE) return deps.env.T212_ENV_FILE;
  let dir = trimTrailingSlashes(deps.cwd);
  while (dir !== '') {
    const candidate = `${dir}/${ENV_FILE_NAME}`;
    if (deps.fileExists(candidate)) return candidate;
    dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/')));
  }
  return undefined;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Local/CLI credentials: env vars T212_API_KEY / T212_API_SECRET / T212_ENV win; otherwise the file named by
 * T212_ENV_FILE (or `.env.trading212.local` at the repo root). Re-read on every call so a file the user fills in
 * later is picked up without restarting. Never logs or returns file content other than the three values.
 */
export function loadLocalCredentials(deps: LocalCredentialDeps): Trading212Credentials {
  let values: Record<string, string | undefined> = deps.env;
  let source = 'the environment';
  if (!deps.env.T212_API_KEY && !deps.env.T212_API_SECRET) {
    const path = locateEnvFile(deps);
    if (!path) {
      throw new BrokerError('NO_CREDENTIALS', `No credentials: set T212_API_KEY/T212_API_SECRET or point T212_ENV_FILE at ${ENV_FILE_NAME}`);
    }
    const content = deps.readFile(path);
    if (content === undefined) throw new BrokerError('NO_CREDENTIALS', `${baseName(path)} does not exist (T212_ENV_FILE=${baseName(path)})`);
    values = parseEnvFile(content);
    source = baseName(path);
  }
  for (const name of ['T212_API_KEY', 'T212_API_SECRET'] as const) {
    if (!values[name]?.trim()) throw new BrokerError('NO_CREDENTIALS', `${name} is empty in ${source}`);
  }
  const environment = (values.T212_ENV ?? 'live').trim().toLowerCase();
  if (!(T212_ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new BrokerError('NO_CREDENTIALS', `T212_ENV must be "live" or "demo" (found in ${source})`);
  }
  return { apiKey: values.T212_API_KEY!.trim(), apiSecret: values.T212_API_SECRET!.trim(), environment: environment as Trading212Credentials['environment'] };
}

/** CredentialSource for the CLI: one local credential set, whatever the user id. */
export class LocalCredentialSource implements CredentialSource {
  constructor(private readonly deps: LocalCredentialDeps) {}

  /** Errors thrown while reading (missing file, empty values) are returned as rejections, never thrown synchronously. */
  get(): Promise<Trading212Credentials> {
    try {
      return Promise.resolve(loadLocalCredentials(this.deps));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
