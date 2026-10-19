import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The workerd suite boots a real runtime (Miniflare): give the first start room.
    setupFiles: ['./test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      // Measured in Node, where the Worker and the Hub run over SQLite compiled to WebAssembly. The same suite runs again in
      // real workerd (test/workerd.test.ts), which proves the behaviour on the real runtime but is not what coverage measures.
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/hub.ts', 'src/index.ts', 'src/runtime.ts'],
      reporter: ['lcov', 'text-summary', 'text'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
