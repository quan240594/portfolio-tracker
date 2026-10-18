/**
 * SecretStore: named, write-mostly secrets (the per-user broker credentials). Values are opaque strings; callers
 * serialise and validate them. A secret value must never be logged or returned by an API endpoint.
 *
 * Implementations: AWS Secrets Manager (`@portfolio/aws`), in-memory, and later an encrypted D1 column.
 */
export interface SecretStore {
  /** The stored value, or null when the secret does not exist. */
  get(name: string): Promise<string | null>;
  /** Creates the secret or replaces its value. */
  put(name: string, value: string): Promise<void>;
  /** Removes the secret; deleting a missing secret is a no-op. */
  delete(name: string): Promise<void>;
}
