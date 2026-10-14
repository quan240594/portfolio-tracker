import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { T212_ENVIRONMENTS, t212SecretName, trading212CredentialsSchema, type Trading212Credentials } from '@portfolio/shared';
import { BrokerError } from './errors.js';

/** Where the sync gets a user's Trading 212 credentials from. */
export interface CredentialSource {
  get(userId: string): Promise<Trading212Credentials | null>;
}

/** Write side, used by the API (PUT/DELETE /brokers/trading212). Secrets are never returned by any endpoint. */
export interface CredentialStore extends CredentialSource {
  put(userId: string, credentials: Trading212Credentials): Promise<void>;
  delete(userId: string): Promise<void>;
}

const isNotFound = (err: unknown) => err instanceof ResourceNotFoundException || (err as Error)?.name === 'ResourceNotFoundException';

/** One secret per user at `{prefix}/{userId}`: JSON `{apiKey, apiSecret, environment}`. Terraform creates no secret value. */
export class SecretsManagerCredentialStore implements CredentialStore {
  constructor(
    private readonly client: Pick<SecretsManagerClient, 'send'>,
    private readonly prefix: string,
  ) {}

  async get(userId: string): Promise<Trading212Credentials | null> {
    const SecretId = t212SecretName(this.prefix, userId);
    let secretString: string | undefined;
    try {
      secretString = (await this.client.send(new GetSecretValueCommand({ SecretId }))).SecretString;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(secretString ?? '');
    } catch {
      throw new BrokerError('NO_CREDENTIALS', 'The stored Trading 212 secret is not valid JSON; reconnect the broker');
    }
    const parsed = trading212CredentialsSchema.safeParse(json);
    if (!parsed.success) throw new BrokerError('NO_CREDENTIALS', 'The stored Trading 212 secret is incomplete; reconnect the broker');
    return parsed.data;
  }

  async put(userId: string, credentials: Trading212Credentials): Promise<void> {
    const SecretId = t212SecretName(this.prefix, userId);
    const SecretString = JSON.stringify(credentials);
    try {
      await this.client.send(new PutSecretValueCommand({ SecretId, SecretString }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.client.send(new CreateSecretCommand({ Name: SecretId, SecretString, Description: 'Trading 212 read-only API credentials' }));
    }
  }

  async delete(userId: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteSecretCommand({ SecretId: t212SecretName(this.prefix, userId), ForceDeleteWithoutRecovery: true }),
      );
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

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
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    out[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** The file named by T212_ENV_FILE, else the nearest `.env.trading212.local` in the cwd or its parents. */
function locateEnvFile(deps: LocalCredentialDeps): string | undefined {
  if (deps.env.T212_ENV_FILE) return deps.env.T212_ENV_FILE;
  let dir = deps.cwd.replace(/\/+$/, '');
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

  get(): Promise<Trading212Credentials> {
    // Errors thrown while reading become rejections.
    return new Promise((resolve) => resolve(loadLocalCredentials(this.deps)));
  }
}
