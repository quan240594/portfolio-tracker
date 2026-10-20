import { expect, it } from 'vitest';
import { createWorkerdStack } from './workerd-stack.js';
import { defineLogoSuite } from './logos-suite.js';
import { defineAppSuite } from './suite.js';

defineAppSuite('workerd (the bundle on the real runtime, Miniflare)', (options) => createWorkerdStack(options));
defineLogoSuite('workerd (the bundle on the real runtime, Miniflare)', (options) => createWorkerdStack(options));

it('keeps the deployed Worker bundle small enough for the free plan', async () => {
  const { bundleWorker } = await import('./workerd-stack.js');
  const bytes = new TextEncoder().encode(await bundleWorker()).byteLength;
  expect(bytes).toBeLessThan(2_500_000); // the free plan accepts 3 MB compressed; the minified bundle is far below
});
