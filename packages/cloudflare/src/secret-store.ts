import { base64ToBytes, bytesToBase64, utf8Bytes, type SecretStore } from '@portfolio/platform';
import { settle } from './settle.js';
import { MeteredSql, type SqlStorageHost, type UsageOptions } from './sql.js';

export const SECRETS_SCHEMA = 'CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID';

const FORMAT = 'v1';
const IV_BYTES = 12;
const MASTER_KEY_BYTES = 32;
/** Domain separation of the derived key: another purpose of the same master key never gets the same AES key. */
const HKDF_INFO = utf8Bytes('portfolio-tracker/cloudflare/secret-store/v1');

type SecretRow = { value: string };

/** A fresh random master key (32 bytes, standard base64): `wrangler secret put` it once as the Worker's secrets key. */
export function generateSecretsKey(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES)));
}

function decodeMasterKey(masterKey: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(masterKey.trim());
  } catch {
    throw new Error('The secrets key must be base64');
  }
  if (bytes.length < MASTER_KEY_BYTES) throw new Error(`The secrets key must hold at least ${MASTER_KEY_BYTES} random bytes (base64)`);
  return bytes;
}

async function deriveKey(masterKey: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', decodeMasterKey(masterKey) as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO as BufferSource },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * SecretStore on the SQLite database of a Durable Object, with every value encrypted at rest (AES-256-GCM).
 *
 * - The key is derived with HKDF-SHA-256 from `masterKey`, a base64 string of at least 32 random bytes that lives in a
 *   Worker secret binding (never in the database or the repository). Generate one with `generateSecretsKey()`.
 * - Every value gets a fresh random 96-bit IV; the stored form is `v1.<base64 iv>.<base64 ciphertext+tag>`.
 * - The secret's name is bound as additional authenticated data, so a ciphertext copied to another name fails.
 * - Plaintext never reaches SQLite, the logs or an error message. A wrong key or a tampered row makes `get` throw.
 */
export class SqlSecretStore implements SecretStore {
  private readonly db: MeteredSql;
  private key: Promise<CryptoKey> | undefined;

  constructor(
    storage: SqlStorageHost,
    private readonly masterKey: string,
    options: UsageOptions = {},
  ) {
    decodeMasterKey(masterKey); // fail at construction, not at the first secret
    this.db = new MeteredSql(storage.sql, options.onUsage);
    this.db.rows(SECRETS_SCHEMA);
  }

  async get(name: string): Promise<string | null> {
    const row = this.db.first<SecretRow>('SELECT value FROM secrets WHERE name = ?', name);
    if (!row) return null;
    return await this.decrypt(name, row.value);
  }

  async put(name: string, value: string): Promise<void> {
    const sealed = await this.encrypt(name, value);
    this.db.rows(
      'INSERT INTO secrets (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value',
      name,
      sealed,
    );
  }

  delete(name: string): Promise<void> {
    return settle(() => {
      this.db.rows('DELETE FROM secrets WHERE name = ?', name);
    });
  }

  private derived(): Promise<CryptoKey> {
    this.key ??= deriveKey(this.masterKey);
    return this.key;
  }

  private async encrypt(name: string, value: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await this.derived();
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8Bytes(name) as BufferSource }, key, utf8Bytes(value) as BufferSource);
    return `${FORMAT}.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(sealed))}`;
  }

  private async decrypt(name: string, stored: string): Promise<string> {
    const [format, iv, ciphertext, ...rest] = stored.split('.');
    if (format !== FORMAT || !iv || !ciphertext || rest.length > 0) throw new Error(`Secret "${name}" is stored in an unknown format`);
    try {
      const key = await this.derived();
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(iv) as BufferSource, additionalData: utf8Bytes(name) as BufferSource },
        key,
        base64ToBytes(ciphertext) as BufferSource,
      );
      return new TextDecoder().decode(plain);
    } catch {
      throw new Error(`Secret "${name}" could not be decrypted (wrong secrets key, or the stored value was changed)`);
    }
  }
}
