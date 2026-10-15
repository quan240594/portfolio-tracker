import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', 'node_modules/**', 'dist/**'],
    // Hermetic AWS: never pick up the developer's profile/SSO session (an AWS_PROFILE in the shell makes the SDK
    // skip the static test credentials and fail once the SSO token expires). Tests stub what they need.
    env: { LOG_LEVEL: 'SILENT', AWS_PROFILE: '', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_CONFIG_FILE: '/dev/null' },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Mirrors sonar.coverage.exclusions in sonar-project.properties.
      exclude: ['src/**/*.test.ts', 'src/**/*.int.test.ts', 'src/testing/**', 'src/local-poller.ts'],
      reporter: ['lcov', 'text-summary', 'text'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
