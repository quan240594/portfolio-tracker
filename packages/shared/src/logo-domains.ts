/**
 * Which website domain stands for a security, so an icon service can be asked for the logo that identifies the holding.
 *
 * Precedence (see docs/architecture.md "Company logos"):
 *   1. the owner's override (`domain` of the classification override)
 *   2. the website a market-data provider reported (`website` of the stored profile)
 *   3. the curated ticker table (logo-domain-table.ts); exchange suffixes of one company resolve to the same domain
 *   4. the ETF issuer prefix of the instrument name ("iShares Core MSCI World ..." -> ishares.com)
 * Nothing here talks to the network and no domain is guessed from a name.
 */
import { SUFFIX_DOMAINS, US_DOMAINS } from './logo-domain-table.js';

export type LogoDomainSource = 'override' | 'provider' | 'table' | 'issuer';

export interface LogoDomainInput {
  symbol: string;
  /** The instrument name as shown (override > profile). */
  name?: string;
  /** `domain` of the owner's classification override. */
  override?: string;
  /** `website` of the stored provider profile. */
  website?: string;
}

export interface LogoDomain {
  domain: string;
  source: LogoDomainSource;
}

const MAX_HOST_LENGTH = 253;
const MAX_INPUT_LENGTH = 300;
const LABEL_CHARS = /^[a-z0-9-]+$/;
const TLD = /^(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})$/;

function validLabel(label: string): boolean {
  return label.length >= 1 && label.length <= 63 && LABEL_CHARS.test(label) && !label.startsWith('-') && !label.endsWith('-');
}

/** The host part of `text` (a bare host or a URL): no scheme, credentials, port, path, query or fragment. */
function hostOf(text: string): string | undefined {
  const schemeEnd = text.indexOf('://');
  const rest = schemeEnd === -1 ? text : text.slice(schemeEnd + 3);
  const end = [...rest].findIndex((char) => char === '/' || char === '?' || char === '#');
  const host = end === -1 ? rest : rest.slice(0, end);
  return host.includes('@') || host.includes(':') ? undefined : host;
}

/**
 * A public host name in lower case without a leading `www.`: `https://www.Apple.com/mac` -> `apple.com`. Anything that is not a
 * plain ASCII DNS name with a real top level (an IP address, `localhost`, a name with a port or credentials) gives undefined, so
 * only public company domains can ever reach an icon service.
 */
export function normalizeDomain(input: string): string | undefined {
  const text = input.trim().toLowerCase();
  if (text === '' || text.length > MAX_INPUT_LENGTH) return undefined;
  const raw = hostOf(text);
  if (raw === undefined) return undefined;
  const absolute = raw.endsWith('.') ? raw.slice(0, -1) : raw;
  const host = absolute.startsWith('www.') ? absolute.slice(4) : absolute;
  const labels = host.split('.');
  const tld = labels.at(-1) ?? '';
  if (host.length > MAX_HOST_LENGTH || labels.length < 2 || !labels.every((label) => validLabel(label)) || !TLD.test(tld)) return undefined;
  return host;
}

/** Exchange suffixes the app writes (`SAP.DE`); a dot followed by anything else is part of the ticker (`BRK.B`). */
const KNOWN_SUFFIXES = new Set(Object.keys(SUFFIX_DOMAINS));

/** `SAP.DE` -> { ticker: 'SAP', suffix: 'DE' }; `BRK.B` and `BRK-B` -> { ticker: 'BRK-B' }. */
export function splitLogoSymbol(symbol: string): { ticker: string; suffix?: string } {
  const upper = symbol.trim().toUpperCase();
  const dot = upper.lastIndexOf('.');
  const suffix = dot === -1 ? undefined : upper.slice(dot + 1);
  if (suffix !== undefined && KNOWN_SUFFIXES.has(suffix)) return { ticker: upper.slice(0, dot).replaceAll('.', '-'), suffix };
  return { ticker: upper.replaceAll('.', '-') };
}

const lookup = (table: Readonly<Record<string, string>> | undefined, ticker: string): string | undefined => (table !== undefined && Object.hasOwn(table, ticker) ? table[ticker] : undefined);

/** The curated domain of a symbol: its own market first, then the US group (cross-listings carry the US ticker). */
export function tableDomain(symbol: string): string | undefined {
  const { ticker, suffix } = splitLogoSymbol(symbol);
  return lookup(suffix === undefined ? undefined : SUFFIX_DOMAINS[suffix], ticker) ?? lookup(US_DOMAINS, ticker);
}

/** ETF and fund issuers by the first word(s) of the instrument name. */
export const ISSUER_DOMAINS: Readonly<Record<string, string>> = {
  amundi: 'amundi.com',
  fidelity: 'fidelity.com',
  'first trust': 'ftportfolios.com',
  franklin: 'franklintempleton.com',
  'global x': 'globalxetfs.com',
  hanetf: 'hanetf.com',
  invesco: 'invesco.com',
  ishares: 'ishares.com',
  pimco: 'pimco.com',
  proshares: 'proshares.com',
  spdr: 'ssga.com',
  vaneck: 'vaneck.com',
  vanguard: 'vanguard.com',
  wisdomtree: 'wisdomtree.com',
  xtrackers: 'xtrackers.com',
};

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** The issuer whose name the instrument name starts with, as a whole word: "iShares Core ..." and "ISHARES(R) ..." but not "Ishare". */
export function issuerDomain(name: string | undefined): string | undefined {
  const lower = (name ?? '').trim().toLowerCase();
  const issuer = Object.keys(ISSUER_DOMAINS).find((prefix) => lower.startsWith(prefix) && !isWordChar(lower[prefix.length]));
  return issuer === undefined ? undefined : ISSUER_DOMAINS[issuer];
}

/** The domain to ask for the logo of a security and where it came from, or undefined when nothing is known. */
export function resolveLogoDomain(input: Readonly<LogoDomainInput>): LogoDomain | undefined {
  const override = input.override === undefined ? undefined : normalizeDomain(input.override);
  if (override !== undefined) return { domain: override, source: 'override' };
  const provider = input.website === undefined ? undefined : normalizeDomain(input.website);
  if (provider !== undefined) return { domain: provider, source: 'provider' };
  const table = tableDomain(input.symbol);
  if (table !== undefined) return { domain: table, source: 'table' };
  const issuer = issuerDomain(input.name);
  return issuer === undefined ? undefined : { domain: issuer, source: 'issuer' };
}
