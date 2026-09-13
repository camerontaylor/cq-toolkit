// cq-toolkit flat ESLint config (T0.2 skeleton).
// Scope: src/ and eslint/rules/. The custom boundary rule no-vendor-sdk-in-kernel
// (invariant I10: kernel stays vendor-neutral) is stubbed here and becomes
// load-bearing in phase 1 — it is applied as an error to src/kernel/** only.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import noVendorSdkInKernel from './eslint/rules/no-vendor-sdk-in-kernel.mjs';

const cq = {
  rules: {
    'no-vendor-sdk-in-kernel': noVendorSdkInKernel,
  },
};

export default [
  {
    ignores: ['dist/', 'coverage/', 'scripts/'],
  },
  js.configs.recommended,
  // typescript-eslint recommended (parser + plugin + eslint-recommended
  // overlay), scoped to TS files under src/ and eslint/rules/.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['src/**/*.ts', 'test/**/*.ts', 'eslint/rules/**/*.ts'],
  })),
  {
    files: ['src/kernel/**'],
    plugins: { cq },
    rules: {
      'cq/no-vendor-sdk-in-kernel': 'error',
    },
  },
];
