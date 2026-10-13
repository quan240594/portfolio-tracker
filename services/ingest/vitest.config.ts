import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', 'node_modules/**', 'dist/**'],
    env: { LOG_LEVEL: 'SILENT' },
  },
});
