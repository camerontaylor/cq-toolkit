// cq-toolkit flat ESLint config (T0.2 skeleton).
// Scope: src/ and eslint/rules/. The custom boundary rule no-vendor-sdk-in-kernel
// (invariant I10: kernel stays vendor-neutral) is already load-bearing — it
// fires as an error on TWO distinct surfaces (review-debt #17, PR #7 Minor:
// keep them distinguished): the KERNEL surface src/kernel/**, whose
// src/kernel/types.ts holds the frozen kernel types and src/kernel/schema.ts
// their zod mirrors, and the DRIVER SEAM surface src/driver/types.ts, which
// holds the frozen driver-seam types (Usage/WorkerResult/OpInvocation —
// types only, no zod mirrors of its own); kernel implementation code lands
// in phase 1.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import noCliBeyondRegistryKernel from './eslint/rules/no-cli-beyond-registry-kernel.mjs';
import noVendorSdkInKernel from './eslint/rules/no-vendor-sdk-in-kernel.mjs';

const cq = {
  rules: {
    'no-vendor-sdk-in-kernel': noVendorSdkInKernel,
    'no-cli-beyond-registry-kernel': noCliBeyondRegistryKernel,
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
    // I10 boundary: the kernel AND the driver seam types stay vendor-neutral.
    // src/driver/types.ts is the seam every vendor driver attaches to, so its
    // frozen types file sits under the same vendor-import ban. The driver
    // implementations (src/driver/drivers/**) adopt vendors deliberately and
    // stay outside this scope.
    files: ['src/kernel/**', 'src/driver/types.ts'],
    plugins: { cq },
    rules: {
      'cq/no-vendor-sdk-in-kernel': 'error',
    },
  },
  {
    // I1 boundary ("no-logic-in-CLI"): the CLI stays a thin dispatcher over
    // the registry + kernel — ./ intra-CLI siblings, ../registry/,
    // ../kernel/, node: builtins, and 'zod' ONLY in the schema-defining
    // subcommand module (src/cli/run-plan.ts). NO ../ops, ../driver,
    // ../harness, ../plans, or vendor packages.
    files: ['src/cli/**', 'src/cli.ts'],
    plugins: { cq },
    rules: {
      'cq/no-cli-beyond-registry-kernel': ['error', { zodFiles: ['src/cli/run-plan.ts'] }],
    },
  },
  {
    // Test fixtures are plain .mjs run by node: timer globals are node
    // built-ins the fixture legitimately uses (the I8 token ban covers
    // src/driver/** only, never test/).
    files: ['test/fixtures/**/*.mjs'],
    languageOptions: {
      globals: {
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
];
