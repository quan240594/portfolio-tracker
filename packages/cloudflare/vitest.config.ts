import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The workerd suites boot a real runtime (Miniflare): give the first start room.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      // The adapters run twice: in Node against SQLite compiled to WebAssembly (this is what the coverage measures) and
      // in real workerd through Miniflare (test/workerd.test.ts), which only proves the same behaviour on the real runtime.
      include: ['src/**'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['lcov', 'text-summary', 'text'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
