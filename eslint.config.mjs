// Flat-config for ESLint v9+ (we're on v10).
// Replaces the missing legacy .eslintrc; before this, `npm run lint` exited
// non-zero from a fresh checkout because ESLint v10 only supports flat config.
//
// Migration reference: https://eslint.org/docs/latest/use/configure/migration-guide

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // 1. Global ignores. Flat config replaces .eslintignore with this.
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cdk.out/**',
      '**/.cdk.staging/**',
      '**/coverage/**',
      '**/*.d.ts',
      // Generated lockfile / non-source artifacts.
      'package-lock.json',
    ],
  },

  // 2. Baseline: ESLint recommended + typescript-eslint recommended.
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // 3. Project-wide TypeScript settings + globals.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow `_`-prefixed unused params/vars — common pattern in CDK
      // construct constructors (scope, id) and AWS Lambda handler signatures.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // CDK + AWS SDK code legitimately uses `any` for runtime-untyped event
      // payloads (Lambda events, dynamic CDK feature flags). Downgrade to warn
      // rather than error; treat as a code-review nudge, not a CI blocker.
      // TODO: enable @typescript-eslint/no-explicit-any as 'error' once Lambda
      // event/handler payloads have explicit types.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // 4. CommonJS config files (e.g. commitlint.config.cjs) — Node globals,
  // CommonJS source type so `module.exports` doesn't trip no-undef.
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },

  // 5. Test files — relax rules that fight common test patterns.
  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
