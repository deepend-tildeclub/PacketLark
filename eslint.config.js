import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['tests/ui/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { process: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['tools/*.mjs'],
    languageOptions: { globals: { window: 'readonly', console: 'readonly' } },
  },
  {
    files: ['**/*.ts', '**/*.cts'],
    rules: { '@typescript-eslint/no-explicit-any': 'error', 'no-control-regex': 'off' },
  },
);
