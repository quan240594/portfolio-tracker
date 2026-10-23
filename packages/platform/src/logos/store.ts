import { isT212Ticker, normalizeDomain } from '@portfolio/shared';
import { base64ToBytes, bytesToBase64 } from '../encoding.js';
import type { ItemStore } from '../item-store.js';
import { LOGO_TYPES, MAX_LOGO_BYTES, sha256Hex, type LogoType } from './image.js';

/**
 * LogoStore: where the logos the server fetched once are kept, by the key they were looked up for: the normalised public domain (so
 * the five iShares ETFs share one row) or `t212:<ticker>` for a logo of the Trading 212 bucket (one per instrument). A found logo is
 * stored with its bytes; a key no source had a logo for is stored too (`missing`, with the time it may be asked again) so it is not
 * fetched on every request.
 *
 * Every item carries the schema version `v` (`LOGO_SCHEMA_VERSION`). An item of another version (the favicon logos and negative
 * entries stored before the Trading 212 source existed have none) is ignored as if it was not there, so it is looked up again,
 * lazily and once, and overwritten.
 *
 * Implementations: `ItemLogoStore` over any `ItemStore` (one item per key: about one row written per logo), tests use it over
 * `MemoryItemStore`.
 */
export interface StoredLogo {
  status: 'found';
  /** Domain or `t212:<ticker>`, see `logoKeys`. */
  key: string;
  contentType: LogoType;
  bytes: Uint8Array;
  /** Strong validator of the bytes, the source and the schema version (`v2-<source>-<hex SHA-256 prefix>`, without quotes): a better source for the same key changes it. */
  etag: string;
  /** Name of the source that served it. */
  source: string;
  /** ISO timestamp. */
  fetchedAt: string;
}

export interface MissingLogo {
  status: 'missing';
  key: string;
  /** ISO timestamp. */
  checkedAt: string;
  /** ISO timestamp: not asked again before this. */
  retryAfter: string;
}

export type LogoEntry = StoredLogo | MissingLogo;

export interface LogoStore {
  get(key: string): Promise<LogoEntry | undefined>;
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

/** The shape of the stored items: 2 = with `source` and `v` (1 = the favicon-only items of before, never read again). */
export const LOGO_SCHEMA_VERSION = 2;

const T212_KEY_PREFIX = 't212:';

/** The key of a logo of the Trading 212 bucket. */
export const t212LogoKey = (ticker: string): string => `${T212_KEY_PREFIX}${ticker}`;

/** Single-table key of a logo: shared by every user (a logo is public information about a company, not about the owner). */
export const logoKeys = {
  logo: (key: string) => ({ PK: `LOGO#${key}`, SK: 'LOGO' }),
} as const;

const ETAG_HEX_CHARS = 32;

const isLogoType = (value: unknown): value is LogoType => (LOGO_TYPES as readonly unknown[]).includes(value);

function requireKey(key: string): string {
  const valid = key.startsWith(T212_KEY_PREFIX) ? isT212Ticker(key.slice(T212_KEY_PREFIX.length)) : normalizeDomain(key) === key;
  if (!valid) throw new Error('A logo is stored under a normalised public domain or a Trading 212 ticker key');
  return key;
}

export class ItemLogoStore implements LogoStore {
  constructor(private readonly items: ItemStore) {}

  async get(key: string): Promise<LogoEntry | undefined> {
    const item = await this.items.get(logoKeys.logo(requireKey(key)));
    if (item?.v !== LOGO_SCHEMA_VERSION) return undefined;
    if (item.status === 'missing' && typeof item.checkedAt === 'string' && typeof item.retryAfter === 'string') return { status: 'missing', key, checkedAt: item.checkedAt, retryAfter: item.retryAfter };
    const { contentType, data, etag, source, fetchedAt } = item;
    if (item.status !== 'found' || !isLogoType(contentType) || typeof data !== 'string' || typeof etag !== 'string' || typeof source !== 'string' || typeof fetchedAt !== 'string') return undefined;
    return { status: 'found', key, contentType, bytes: base64ToBytes(data), etag, source, fetchedAt };
  }

  async putFound(logo: Omit<StoredLogo, 'status' | 'etag'>): Promise<StoredLogo> {
    if (logo.bytes.length > MAX_LOGO_BYTES) throw new LogoTooLargeError(logo.bytes.length);
    const etag = `v${LOGO_SCHEMA_VERSION}-${logo.source}-${(await sha256Hex(logo.bytes)).slice(0, ETAG_HEX_CHARS)}`;
    await this.items.put({
      ...logoKeys.logo(requireKey(logo.key)),
      entityType: LOGO_ENTITY,
      v: LOGO_SCHEMA_VERSION,
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
    await this.items.put({ ...logoKeys.logo(requireKey(entry.key)), entityType: LOGO_ENTITY, v: LOGO_SCHEMA_VERSION, status: 'missing', checkedAt: entry.checkedAt, retryAfter: entry.retryAfter });
    return { ...entry, status: 'missing' };
  }
}
