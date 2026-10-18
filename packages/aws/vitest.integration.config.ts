import { defineConfig } from 'vitest/config';

/** Integration tests run against LocalStack (:4566) and only when LOCALSTACK=1. */
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'SILENT' },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    passWithNoTests: true,
    fileParallelism: false,
  },
});
