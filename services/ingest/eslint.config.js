import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { process: 'readonly', console: 'readonly', crypto: 'readonly', Buffer: 'readonly', URL: 'readonly', setTimeout: 'readonly', fetch: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Cloud SDKs live in @portfolio/aws; the service only talks to the ports of @portfolio/platform.
      'no-restricted-imports': ['error', { patterns: [{ group: ['@aws-sdk/*', '@aws-lambda-powertools/*'], message: 'Use the ports of @portfolio/platform and the adapters of @portfolio/aws.' }] }],
    },
  },
  {
    files: ['**/*.test.ts', 'src/testing/**', 'src/local-poller.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
