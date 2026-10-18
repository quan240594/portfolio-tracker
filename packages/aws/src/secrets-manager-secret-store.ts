import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { SecretStore } from '@portfolio/platform';

const isNotFound = (err: unknown) => err instanceof ResourceNotFoundException || (err as Error)?.name === 'ResourceNotFoundException';

/** SecretStore on AWS Secrets Manager: one secret per name. Terraform creates no secret and no secret value. */
export class SecretsManagerSecretStore implements SecretStore {
  constructor(
    private readonly client: Pick<SecretsManagerClient, 'send'>,
    private readonly description = 'Portfolio tracker secret',
  ) {}

  async get(name: string): Promise<string | null> {
    try {
      const res = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
      return res.SecretString ?? '';
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(name: string, value: string): Promise<void> {
    try {
      await this.client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.client.send(new CreateSecretCommand({ Name: name, SecretString: value, Description: this.description }));
    }
  }

  async delete(name: string): Promise<void> {
    try {
      await this.client.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}
