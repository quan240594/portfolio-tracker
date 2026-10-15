import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    env: { LOG_LEVEL: 'SILENT' },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Mirrors sonar.coverage.exclusions in sonar-project.properties.
      exclude: ['src/**/*.test.ts', 'src/testing/**', 'src/cli.ts'],
      reporter: ['lcov', 'text-summary', 'text'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
