// RuleTester suite for the CLI import-boundary rule ("no-logic-in-CLI", I1).
// The rule CORE checks every import source against the CLI allowlist
// (./ siblings, ../registry/, ../kernel/, node: builtins, and 'zod' only in
// the configured zodFiles); the src/cli/** scoping lives in eslint.config.js
// (the rule is applied to src/cli/** and src/cli.ts there). Because RuleTester
// runs the rule core without the repo config, a violation OUTSIDE src/cli is
// a valid case of the CONFIG, not of the rule, and cannot be expressed here —
// it is covered by the eslint.config.js files scoping.
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import rule from './no-cli-beyond-registry-kernel.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

// The option shape eslint.config.js passes for src/cli/**.
const OPTIONS = [{ zodFiles: ['src/cli/run-plan.ts'] }];

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

ruleTester.run('no-cli-beyond-registry-kernel', rule, {
  valid: [
    {
      code: "import { runPlanCommand } from './run-plan.js';",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
    },
    {
      code: "import { list } from '../registry/index.js';",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
    },
    {
      code: "import type { RunOptions } from '../kernel/types.js';", // TS syntax: TS parser needed
      filename: 'src/cli/run-plan.ts',
      options: OPTIONS,
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parser: tseslint.parser },
    },
    {
      code: "import { readFile } from 'node:fs/promises';",
      filename: 'src/cli/run-plan.ts',
      options: OPTIONS,
    },
    {
      code: "import { z } from 'zod';", // zodFiles allowlist hit
      filename: 'src/cli/run-plan.ts',
      options: OPTIONS,
    },
    {
      code: "const { join } = require('node:path');",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
    },
    {
      code: "export { runCli } from './main.js';", // re-export sources checked too
      filename: 'src/cli.ts',
      options: OPTIONS,
    },
  ],
  invalid: [
    {
      code: "import { registry } from '../ops/gates/registry.js';",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      code: "import { makeDriver } from '../driver/index.js';",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      code: "import { sessionOf } from '../harness/session.js';",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      code: "import { planOf } from '../plans/index.js';",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      code: "import { z } from 'zod';", // outside zodFiles: the main dispatcher defines no schema
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      code: "import pLimit from 'p-limit';", // vendor packages banned outright
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      code: "export * from '../plans/index.js';",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      code: "import('../ops/gates/registry.js');", // dynamic imports are flagged too
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      code: "const mod = require('../driver/types.js');",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
  ],
});
