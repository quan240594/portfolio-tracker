import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The contract suites are test code exercised by the in-memory implementations (and by every adapter package).
      exclude: ['src/**/*.test.ts', 'src/testing/**'],
      reporter: ['lcov', 'text-summary', 'text'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
