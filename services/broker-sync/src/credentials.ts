import type { SecretStore } from '@portfolio/platform';
import { t212SecretName, trading212CredentialsSchema, type Trading212Credentials } from '@portfolio/shared';
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

/**
 * Credentials on top of a SecretStore: one secret per user at `{prefix}/{userId}` holding the JSON
 * `{apiKey, apiSecret, environment}`. The validation lives here, so every SecretStore adapter gets it.
 */
export class SecretCredentialStore implements CredentialStore {
  constructor(
    private readonly secrets: SecretStore,
    private readonly prefix: string,
  ) {}

  async get(userId: string): Promise<Trading212Credentials | null> {
    const secretString = await this.secrets.get(t212SecretName(this.prefix, userId));
    if (secretString === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(secretString);
    } catch {
      throw new BrokerError('NO_CREDENTIALS', 'The stored Trading 212 secret is not valid JSON; reconnect the broker');
    }
    const parsed = trading212CredentialsSchema.safeParse(json);
    if (!parsed.success) throw new BrokerError('NO_CREDENTIALS', 'The stored Trading 212 secret is incomplete; reconnect the broker');
    return parsed.data;
  }

  async put(userId: string, credentials: Trading212Credentials): Promise<void> {
    await this.secrets.put(t212SecretName(this.prefix, userId), JSON.stringify(credentials));
  }

  async delete(userId: string): Promise<void> {
    await this.secrets.delete(t212SecretName(this.prefix, userId));
  }
}
