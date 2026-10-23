import { DEFAULT_T212_LOGO_BASE, LOGO_SOURCE_NAMES, normalizeT212LogoBase, type LogoSourceName } from './sources.js';

/** Settings of the logo service, from Worker variables (all optional) and the optional secret `LOGO_DEV_TOKEN`. */
export interface LogosConfig {
  /** Sources in the order they are tried; empty switches logos off (every logo request answers "none"). */
  sources: LogoSourceName[];
  /** Secret of the token-based source; without it that source is skipped. */
  logoDevToken?: string;
  /** Base URL of the Trading 212 logo bucket (`LOGO_T212_BASE`): an https amazonaws.com origin, else the default. */
  t212Base: string;
  /** Tests only (`LOGO_ALLOW_ANY_HOST=1`): lets `t212Base` be any http(s) origin, for a fake upstream. */
  allowAnyHost: boolean;
  /** Most lookups (a domain or an instrument) made at the sources in one clock hour (each lookup tries the sources one after the other). */
  hourlyLimit: number;
  /** Days a domain nobody had a logo for is not asked again. */
  negativeTtlDays: number;
}

export const DEFAULT_LOGO_SOURCES: readonly LogoSourceName[] = ['t212', 'logodev', 'google', 'duckduckgo'];
export const DEFAULT_LOGO_HOURLY_LIMIT = 30;
export const MAX_LOGO_HOURLY_LIMIT = 500;
export const DEFAULT_LOGO_NEGATIVE_TTL_DAYS = 7;
const MAX_NEGATIVE_TTL_DAYS = 90;

function integerIn(raw: string | undefined, fallback: number, min: number, max: number): number {
  const text = (raw ?? '').trim();
  if (!/^\d{1,6}$/.test(text)) return fallback;
  const value = Number(text);
  return value >= min && value <= max ? value : fallback;
}

/** `LOGO_SOURCES` is a comma separated list of source names (`off` = none); unknown names are ignored, order is kept, repeats dropped. */
function sourcesOf(raw: string | undefined): LogoSourceName[] {
  const text = (raw ?? '').trim().toLowerCase();
  if (text === '') return [...DEFAULT_LOGO_SOURCES];
  const names = text.split(',').map((name) => name.trim());
  const known = names.filter((name): name is LogoSourceName => (LOGO_SOURCE_NAMES as readonly string[]).includes(name));
  return [...new Set(known)];
}

export function parseLogosConfig(env: Readonly<Record<string, string | undefined>>): LogosConfig {
  const token = (env.LOGO_DEV_TOKEN ?? '').trim();
  const allowAnyHost = (env.LOGO_ALLOW_ANY_HOST ?? '').trim() === '1';
  return {
    sources: sourcesOf(env.LOGO_SOURCES),
    ...(token === '' ? {} : { logoDevToken: token }),
    t212Base: normalizeT212LogoBase(env.LOGO_T212_BASE, { allowAnyHost }) ?? DEFAULT_T212_LOGO_BASE,
    allowAnyHost,
    hourlyLimit: integerIn(env.LOGO_HOURLY_LIMIT, DEFAULT_LOGO_HOURLY_LIMIT, 0, MAX_LOGO_HOURLY_LIMIT),
    negativeTtlDays: integerIn(env.LOGO_NEGATIVE_TTL_DAYS, DEFAULT_LOGO_NEGATIVE_TTL_DAYS, 1, MAX_NEGATIVE_TTL_DAYS),
  };
}
