// RuleTester suite for the harness→driver boundary rule (migration 1.1).
// The rule CORE reports every relative import source that RESOLVES into
// src/driver/ (resolve-then-contain, no fs), except the src/driver/types.ts
// contracts seam. The src/harness/** scoping and the ERROR severity live in
// .oxlintrc.json — a violation OUTSIDE src/harness is a valid case of the
// CONFIG, not of the rule, and cannot be expressed here; it is covered by
// test/scripts/oxlint-boundaries.test.ts, which runs the real config.
import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import rule from './no-driver-import-in-harness.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
});

const tools = (code: string) => ({ code, filename: 'src/harness/tools.ts' });
const driverImport = (code: string, filename = 'src/harness/tools.ts') => ({
  code,
  filename,
  errors: [{ messageId: 'driverImport' }],
});

ruleTester.run('no-driver-import-in-harness', rule, {
  valid: [
    // The post-1.1 correct edges: harness consumes src/shared/**, in every
    // import form.
    tools("import { buildChildEnv } from '../shared/proc.js';"),
    tools("export { terminateGracefully } from '../shared/proc.js';"),
    tools("await import('../shared/proc.js');"),
    tools("type T = import('../shared/proc.js').ChildEnv;"),
    tools("import proc = require('../shared/proc.js');"),
    // The contracts seam: src/driver/types.ts becomes @cq/contracts.
    tools("import type { SandboxLevel, ToolDenial } from '../driver/types.js';"),
    tools("type T = import('../driver/types.js').SandboxLevel;"),
    tools("import type { SandboxLevel } from '../driver/types';"),
    tools("import type { SandboxLevel } from '../shared/../driver/types.js';"),
    {
      code: "import type { SandboxLevel } from '../../driver/types.js';",
      filename: 'src/harness/mcp/startup.ts',
    },
    // A namespace alias is not a module import.
    tools('namespace Local { export type T = string; } import T = Local.T;'),
    // A local function named createRequire is not require().
    tools(
      "const createRequire = () => (_source: string) => {}; createRequire()('../driver/run.js');",
    ),
    // Intra-harness and sibling non-driver layers.
    tools("import { runArgvCommand } from './run.js';"),
    tools("import { harnessRunGate } from '../sandbox/index.js';"),
    // Bare specifiers and node: builtins are out of scope.
    tools("import { readFile } from 'node:fs/promises';"),
    tools("import { z } from 'zod';"),
    // Segment-boundary probes: neither is src/driver/ or the seam itself.
    tools("import { x } from '../driver-x/types.js';"),
    tools("import type { T } from '../shared/driver/types.js';"),
    {
      // Windows absolute importer path anchors at the LAST '/src/' segment.
      code: "import { buildChildEnv } from '../shared/proc.js';",
      filename: 'C:\\repo\\src\\harness\\tools.ts',
    },
  ],
  invalid: [
    // The edge migration 1.1 kills, in every import form.
    driverImport("import { buildChildEnv } from '../driver/subprocess/process.js';"),
    driverImport("import type { SpawnOptions } from '../driver/subprocess/process.js';"),
    driverImport("export * from '../driver/subprocess/index.js';"),
    driverImport("export { SubprocessDriver } from '../driver/subprocess/index.js';"),
    driverImport("await import('../driver/subprocess/index.js');"),
    driverImport('await import(`../driver/subprocess/index.js`);'),
    driverImport("const { x } = require('../driver/subprocess/index.js');"),
    driverImport("type T = import('../driver/schema.js').WorkerResultSchema;"),
    driverImport("import driver = require('../driver/errors.js');"),
    driverImport("import type driver = require('../driver/errors.js');"),
    driverImport("export import driver = require('../driver/errors.js');"),
    // Only the seam FILE is allowed, not the driver root or a types/ dir.
    driverImport("import '../driver';"),
    driverImport("import '../driver/index.js';"),
    driverImport("import type { T } from '../driver/types/extra.js';"),
    // Deeper harness directory: '../../driver/…' still resolves into the tree.
    driverImport(
      "import { buildChildEnv } from '../../driver/subprocess/process.js';",
      'src/harness/mcp/startup.ts',
    ),
    // Traversal and separator spellings resolve before containment.
    driverImport("import { t } from '../shared/../driver/errors.js';"),
    driverImport("type T = import('../shared/../driver/errors.js').E;"),
    driverImport("import '../driver\\\\subprocess\\\\process.js';"),
    driverImport(
      "import { buildChildEnv } from '../driver/subprocess/process.js';",
      'C:\\repo\\src\\harness\\tools.ts',
    ),
    {
      // FAIL CLOSED: a computed source hides its real target and is reported
      // outright (`const t = '../driver/errors.js'; await import(t);`).
      code: "const t = '../driver/errors.js';\nawait import(t);",
      filename: 'src/harness/tools.ts',
      errors: [{ messageId: 'computedSource' }],
    },
    {
      code: "const t = '../driver/errors.js';\nrequire(t);",
      filename: 'src/harness/tools.ts',
      errors: [{ messageId: 'computedSource' }],
    },
  ],
});
