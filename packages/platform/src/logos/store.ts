import { normalizeDomain } from '@portfolio/shared';
import { base64ToBytes, bytesToBase64 } from '../encoding.js';
import type { ItemStore } from '../item-store.js';
import { LOGO_TYPES, MAX_LOGO_BYTES, sha256Hex, type LogoType } from './image.js';

/**
 * LogoStore: where the logos the server fetched once are kept, by the domain they were looked up for (so the five iShares ETFs
 * share one row). A found logo is stored with its bytes; a domain no source had a logo for is stored too (`missing`, with the time
 * it may be asked again) so it is not fetched on every request.
 *
 * Implementations: `ItemLogoStore` over any `ItemStore` (one item per domain: about one row written per logo), tests use it over
 * `MemoryItemStore`.
 */
export interface StoredLogo {
  status: 'found';
  domain: string;
  contentType: LogoType;
  bytes: Uint8Array;
  /** Strong validator of the bytes (hex SHA-256 prefix, without quotes). */
  etag: string;
  /** Name of the source that served it. */
  source: string;
  /** ISO timestamp. */
  fetchedAt: string;
}

export interface MissingLogo {
  status: 'missing';
  domain: string;
  /** ISO timestamp. */
  checkedAt: string;
  /** ISO timestamp: not asked again before this. */
  retryAfter: string;
}

export type LogoEntry = StoredLogo | MissingLogo;

export interface LogoStore {
  get(domain: string): Promise<LogoEntry | undefined>;
  /** Throws `LogoTooLargeError` for more than `MAX_LOGO_BYTES`. */
  putFound(logo: Omit<StoredLogo, 'status' | 'etag'>): Promise<StoredLogo>;
  putMissing(entry: Omit<MissingLogo, 'status'>): Promise<MissingLogo>;
}

export class LogoTooLargeError extends Error {
  constructor(size: number) {
    super(`A logo of ${size} bytes is over the cap of ${MAX_LOGO_BYTES} bytes`);
    this.name = 'LogoTooLargeError';
  }
}

export const LOGO_ENTITY = 'LOGO';

/** Single-table key of a logo: shared by every user (a logo is public information about a company, not about the owner). */
export const logoKeys = {
  logo: (domain: string) => ({ PK: `LOGO#${domain}`, SK: 'LOGO' }),
} as const;

const ETAG_HEX_CHARS = 32;

const isLogoType = (value: unknown): value is LogoType => (LOGO_TYPES as readonly unknown[]).includes(value);

function requireDomain(domain: string): string {
  if (normalizeDomain(domain) !== domain) throw new Error('A logo is stored under a normalised public domain');
  return domain;
}

export class ItemLogoStore implements LogoStore {
  constructor(private readonly items: ItemStore) {}

  async get(domain: string): Promise<LogoEntry | undefined> {
    const item = await this.items.get(logoKeys.logo(requireDomain(domain)));
    if (item === undefined) return undefined;
    if (item.status === 'missing' && typeof item.checkedAt === 'string' && typeof item.retryAfter === 'string') return { status: 'missing', domain, checkedAt: item.checkedAt, retryAfter: item.retryAfter };
    const { contentType, data, etag, source, fetchedAt } = item;
    if (item.status !== 'found' || !isLogoType(contentType) || typeof data !== 'string' || typeof etag !== 'string' || typeof source !== 'string' || typeof fetchedAt !== 'string') return undefined;
    return { status: 'found', domain, contentType, bytes: base64ToBytes(data), etag, source, fetchedAt };
  }

  async putFound(logo: Omit<StoredLogo, 'status' | 'etag'>): Promise<StoredLogo> {
    if (logo.bytes.length > MAX_LOGO_BYTES) throw new LogoTooLargeError(logo.bytes.length);
    const etag = (await sha256Hex(logo.bytes)).slice(0, ETAG_HEX_CHARS);
    await this.items.put({
      ...logoKeys.logo(requireDomain(logo.domain)),
      entityType: LOGO_ENTITY,
      status: 'found',
      contentType: logo.contentType,
      data: bytesToBase64(logo.bytes),
      size: logo.bytes.length,
      etag,
      source: logo.source,
      fetchedAt: logo.fetchedAt,
    });
    return { ...logo, status: 'found', etag };
  }

  async putMissing(entry: Omit<MissingLogo, 'status'>): Promise<MissingLogo> {
    await this.items.put({ ...logoKeys.logo(requireDomain(entry.domain)), entityType: LOGO_ENTITY, status: 'missing', checkedAt: entry.checkedAt, retryAfter: entry.retryAfter });
    return { ...entry, status: 'missing' };
  }
}
