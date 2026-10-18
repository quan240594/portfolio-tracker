import { describe, expect, it } from 'vitest';
import type { SecretStore } from '../secret-store.js';

type Factory = () => SecretStore | Promise<SecretStore>;

/** Behaviour every SecretStore adapter must have. Secret names are namespaced per run, so a shared backend is fine. */
export function runSecretStoreContract(name: string, create: Factory): void {
  describe(`SecretStore contract: ${name}`, () => {
    const ns = crypto.randomUUID();
    let counter = 0;
    const secretName = () => `contract-${ns}-${++counter}`;

    it('returns null for a secret that does not exist', async () => {
      expect(await (await create()).get(secretName())).toBeNull();
    });

    it('creates, reads and replaces a secret', async () => {
      const store = await create();
      const id = secretName();
      await store.put(id, '{"apiKey":"k1"}');
      expect(await store.get(id)).toBe('{"apiKey":"k1"}');
      await store.put(id, 'second value ✓');
      expect(await store.get(id)).toBe('second value ✓');
    });

    it('keeps secrets with different names apart', async () => {
      const store = await create();
      const [a, b] = [secretName(), secretName()];
      await store.put(a, 'A');
      await store.put(b, 'B');
      expect([await store.get(a), await store.get(b)]).toEqual(['A', 'B']);
    });

    it('deletes a secret; deleting a missing one is a no-op', async () => {
      const store = await create();
      const id = secretName();
      await store.put(id, 'x');
      await store.delete(id);
      expect(await store.get(id)).toBeNull();
      await expect(store.delete(id)).resolves.toBeUndefined();
    });

    it('can recreate a deleted secret', async () => {
      const store = await create();
      const id = secretName();
      await store.put(id, 'one');
      await store.delete(id);
      await store.put(id, 'two');
      expect(await store.get(id)).toBe('two');
    });
  });
}
