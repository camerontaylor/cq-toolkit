// RuleTester suite for the CLI import-boundary rule ("no-logic-in-CLI", I1).
// The rule CORE checks every import source by RESOLVE-THEN-CONTAIN: relative
// sources are resolved lexically against the importing file's repo-relative
// path, and the RESOLVED path must land inside src/cli/ — or, when the
// importing file itself is under src/cli/**, inside src/registry/ or
// src/kernel/ (node: builtins everywhere; 'zod' only in the configured
// zodFiles). The src/cli/** scoping lives in .oxlintrc.json (the rule is
// applied to src/cli/** and src/cli.ts there). Because RuleTester runs the
// rule core without the repo config, a violation OUTSIDE src/cli is a valid
// case of the CONFIG, not of the rule, and cannot be expressed here — it is
// covered by the .oxlintrc.json files scoping.
import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import rule from './no-cli-beyond-registry-kernel.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

// The option shape .oxlintrc.json passes for src/cli/**.
const OPTIONS = [{ zodFiles: ['src/cli/run-plan.ts'] }];

const ruleTester = new RuleTester({
  languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
});

ruleTester.run('no-cli-beyond-registry-kernel', rule, {
  valid: [
    {
      code: "import '../kernel/types.js';",
      filename: 'C:\\repo\\src\\cli\\main.ts',
      options: OPTIONS,
    },
    { code: "import 'zod';", filename: 'C:\\repo\\src\\cli\\run-plan.ts', options: OPTIONS },
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
      languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
    },
    {
      // Inline import type — the source goes through the same
      // resolve-and-contain check: '../kernel/types.js' resolves to
      // src/kernel/types.js, an allowed root for a file under src/cli/**.
      code: "type T = import('../kernel/types.js').T;",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
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
      // The bin shim (src/cli.ts lives in src/, not src/cli/): its ONLY
      // allowed relative targets are src/cli/** — './cli/main.js' resolves
      // inside ('./main.js' would resolve to src/main.js and is flagged).
      code: "export { runCli } from './cli/main.js';", // re-export sources checked too
      filename: 'src/cli.ts',
      options: OPTIONS,
    },
    {
      code: "import { runCli } from './cli/main.js';", // shim: resolves into src/cli/
      filename: 'src/cli.ts',
      options: OPTIONS,
    },
  ],
  invalid: [
    {
      code: "import '../kernel/../driver/index.js';",
      filename: 'C:\\repo\\src\\cli\\main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      code: "import '../cli-extra/index.js';",
      filename: 'C:\\repo\\src\\cli\\main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
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
      // Traversal bypass probe: textually starts with './', resolves OUTSIDE
      // the CLI layer (src/ops/index.js) — resolve-then-contain catches it.
      code: "import { gates } from './../ops/index.js';",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      // Traversal bypass probe: textually starts with '../kernel/', resolves
      // to src/driver/index.js — a raw prefix match would let it through.
      code: "import { makeDriver } from '../kernel/../driver/index.js';",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      // Multi-hop traversal: './' + '../' segments collapse to docs/, far
      // outside src/cli|registry|kernel.
      code: "import { x } from '../ops/../../docs/x.js';",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      // The shim may reach ONLY src/cli/** relatively: './driver/x.js'
      // resolves to src/driver/x.js — outside the CLI layer.
      code: "import { makeDriver } from './driver/x.js';",
      filename: 'src/cli.ts',
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
    {
      // Computed dynamic import — FAIL CLOSED: sourceText() is null, so
      // resolve-then-contain cannot see the real target ('../ops/x.js' never
      // appears as a literal); a silent accept would be the boundary bypass.
      code: "const target = '../ops/x.js';\nawait import(target);",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      // Computed require() — the same fail-closed treatment.
      code: "const target = '../ops/x.js';\nconst mod = require(target);",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      // Inline import type reaching OUTSIDE the boundary: resolves to
      // src/driver/types.js — reported like the equivalent static import.
      code: "type D = import('../driver/types.js').Driver;",
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
    {
      // Computed inline import type — FAIL CLOSED: no literal source text, so
      // resolve-then-contain cannot see the real target; reported outright.
      code: 'type E = import(target).E;',
      filename: 'src/cli/main.ts',
      options: OPTIONS,
      languageOptions: {
        sourceType: 'module',
        parserOptions: { lang: 'ts', ignoreNonFatalErrors: true },
      },
      errors: [{ messageId: 'beyondRegistryKernel' }],
    },
  ],
});
