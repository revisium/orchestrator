// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import localRules from './eslint-local-rules/index.js';

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.node,
      },
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Empty `catch {}` is intentional throughout (swallowed best-effort side effects);
      // the policy removed inline prose comments, so allow empty catches explicitly.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Comment policy (HARD RULE) — ban dead-pointer / crypto-tag tokens in src comments.
    // Scoped to product source; tests and e2e are excluded. See VERIFICATION.md.
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/e2e/**'],
    plugins: { local: localRules },
    rules: {
      'local/no-dead-pointers': 'error',
    },
  },
];
