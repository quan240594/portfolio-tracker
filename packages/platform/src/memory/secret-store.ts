import type { SecretStore } from '../secret-store.js';

/** In-memory SecretStore (reference implementation and test double). */
export class MemorySecretStore implements SecretStore {
  // A private field keeps values out of `JSON.stringify`/`console.log` dumps of the store.
  readonly #secrets = new Map<string, string>();

  get(name: string): Promise<string | null> {
    return Promise.resolve(this.#secrets.get(name) ?? null);
  }

  put(name: string, value: string): Promise<void> {
    this.#secrets.set(name, value);
    return Promise.resolve();
  }

  delete(name: string): Promise<void> {
    this.#secrets.delete(name);
    return Promise.resolve();
  }

  /** Names of the stored secrets (never their values). For assertions in tests. */
  names(): string[] {
    return [...this.#secrets.keys()];
  }
}
