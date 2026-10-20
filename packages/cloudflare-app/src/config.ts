import { parsePricesConfig, type PricesConfig } from '@portfolio/prices';
import { MIN_SESSION_SECRET_LENGTH, parseAllowedHosts, parseLogosConfig, resolveGithubAuthConfig, type GithubAuthConfig, type GithubFetch, type LogosConfig } from '@portfolio/platform';
import type { HubEnv, WorkerEnv } from './runtime.js';

export type ConfigResult<T> = { ok: true; config: T } | { ok: false; problems: string[] };

/** What the Hub needs from its variables, validated. */
export interface HubConfig {
  secretsKey: string;
  /** `https://host` (no path), the origin of the upload URLs and of CORS. */
  origin: string;
  baseCurrency: string;
  /** Prefix of the Trading 212 credential secrets in the encrypted secret store. */
  brokerSecretPrefix: string;
  symbolOverrides: Record<string, string>;
  /** The price service's configuration (provider keys are optional). */
  prices: PricesConfig;
  /** The company logo service: sources, hourly lookup cap, negative cache (see `parseLogosConfig`). */
  logos: LogosConfig;
  /** Web Push: both keys are needed, otherwise the notification feature is off (never an error). */
  push: PushSettings;
}

export interface PushSettings {
  publicKey?: string;
  privateKey?: string;
  allowedHosts: readonly string[];
}

export const DEFAULT_BASE_CURRENCY = 'EUR';
export const BROKER_SECRET_PREFIX = '/portfolio-tracker/cloudflare/broker/trading212';
const MIN_SECRETS_KEY_BYTES = 32;

const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';

function decodedLength(base64: string): number | undefined {
  try {
    return atob(base64).length;
  } catch {
    return undefined;
  }
}

function parseOverrides(raw: string | undefined): Record<string, string> {
  if (!present(raw)) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    }
  } catch {
    // invalid JSON means no overrides, like the AWS configuration
  }
  return {};
}

/** The origin of `ORIGIN` or undefined when it is not an http(s) URL. Only the origin is kept: a path would break the upload URLs. */
function originOf(value: string | undefined): string | undefined {
  if (!present(value)) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The string-valued entries of the environment (bindings such as the Durable Object namespace are objects and not configuration). */
function stringVars(env: HubEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** Validates the Hub's variables. The problems name the variable, never its value. */
export function readHubConfig(env: HubEnv): ConfigResult<HubConfig> {
  const problems: string[] = [];
  const keyLength = present(env.SECRETS_KEY) ? decodedLength(env.SECRETS_KEY.trim()) : undefined;
  if (keyLength === undefined || keyLength < MIN_SECRETS_KEY_BYTES) problems.push(`SECRETS_KEY must be a base64 key of at least ${MIN_SECRETS_KEY_BYTES} bytes (generateSecretsKey())`);
  const origin = originOf(env.ORIGIN);
  if (origin === undefined) problems.push('ORIGIN must be the https origin of the app');
  const currency = (env.BASE_CURRENCY ?? '').trim() || DEFAULT_BASE_CURRENCY;
  if (!/^[A-Za-z]{3}$/.test(currency)) problems.push('BASE_CURRENCY must be a three-letter currency code');
  if (problems.length > 0 || origin === undefined) return { ok: false, problems };
  return {
    ok: true,
    config: {
      secretsKey: env.SECRETS_KEY!.trim(),
      origin,
      baseCurrency: currency.toUpperCase(),
      brokerSecretPrefix: BROKER_SECRET_PREFIX,
      symbolOverrides: parseOverrides(env.T212_SYMBOL_OVERRIDES),
      prices: parsePricesConfig({ ...stringVars(env), BASE_CURRENCY: currency.toUpperCase() }),
      logos: parseLogosConfig(stringVars(env)),
      push: {
        ...(present(env.VAPID_PUBLIC_KEY) ? { publicKey: env.VAPID_PUBLIC_KEY.trim() } : {}),
        ...(present(env.VAPID_PRIVATE_KEY) ? { privateKey: env.VAPID_PRIVATE_KEY.trim() } : {}),
        allowedHosts: parseAllowedHosts(env.PUSH_ALLOWED_HOSTS),
      },
    },
  };
}

export interface WorkerConfigOptions {
  /** Replaces the global `fetch` of the GitHub calls (tests). */
  fetch?: GithubFetch;
  now?: () => number;
}

/** Validates the sign-in variables of the Worker (`GITHUB_*`, `SESSION_SECRET`, `OWNER_GITHUB_ID`, `ORIGIN`). */
export function readWorkerConfig(env: WorkerEnv, options: WorkerConfigOptions = {}): ConfigResult<GithubAuthConfig> {
  const problems: string[] = [];
  if (!present(env.GITHUB_CLIENT_ID)) problems.push('GITHUB_CLIENT_ID is missing');
  if (!present(env.GITHUB_CLIENT_SECRET)) problems.push('GITHUB_CLIENT_SECRET is missing');
  if ((env.SESSION_SECRET ?? '').length < MIN_SESSION_SECRET_LENGTH) problems.push(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
  const ownerId = /^[1-9]\d{0,15}$/.test(env.OWNER_GITHUB_ID?.trim() ?? '') ? Number(env.OWNER_GITHUB_ID!.trim()) : undefined;
  if (ownerId === undefined) problems.push('OWNER_GITHUB_ID must be the numeric GitHub user id of the owner');
  const origin = originOf(env.ORIGIN);
  if (origin === undefined) problems.push('ORIGIN must be the https origin of the app');
  if (problems.length > 0 || ownerId === undefined || origin === undefined) return { ok: false, problems };
  const config: GithubAuthConfig = {
    clientId: env.GITHUB_CLIENT_ID!.trim(),
    clientSecret: env.GITHUB_CLIENT_SECRET!,
    ownerGithubId: ownerId,
    sessionSecret: env.SESSION_SECRET!,
    origin,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  try {
    resolveGithubAuthConfig(config);
  } catch (error) {
    // The platform validation messages never contain secret values.
    return { ok: false, problems: [error instanceof Error ? error.message : 'The sign-in configuration is invalid'] };
  }
  return { ok: true, config };
}
