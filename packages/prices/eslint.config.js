import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Must run on any JavaScript runtime (Node, Workers): only Web-standard globals, no Node built-ins.
    languageOptions: {
      globals: { console: 'readonly', crypto: 'readonly', URL: 'readonly', setTimeout: 'readonly', fetch: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', btoa: 'readonly', atob: 'readonly', structuredClone: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-imports': ['error', { patterns: [{ group: ['node:*', '@aws-sdk/*', 'aws-lambda'], message: 'The price package runs on Workers and Durable Objects: no Node built-ins and no AWS SDK.' }] }],
      'no-restricted-globals': ['error', ...['Buffer', 'process', 'require', '__dirname'].map((name) => ({ name, message: 'Not available in Workers: use Web-standard APIs.' }))],
    },
  },
  {
    files: ['**/*.test.ts', 'vitest.config.ts', 'src/testing/**'],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-globals': 'off' },
  },
);
