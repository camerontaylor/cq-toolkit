// RuleTester suite for the harness→driver boundary rule (migration 1.1).
// The rule CORE reports every relative import source that RESOLVES into
// src/driver/ (resolve-then-contain, no fs). The src/harness/** scoping and
// the WARN severity live in .oxlintrc.json — a violation OUTSIDE src/harness
// is a valid case of the CONFIG, not of the rule, and cannot be expressed
// here; it is covered by test/scripts/oxlint-boundaries.test.ts, which runs
// the real config.
import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import rule from './no-driver-import-in-harness.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
});

ruleTester.run('no-driver-import-in-harness', rule, {
  valid: [
    {
      code: "import '../%73hared/proc.js?mode=test#part';",
      filename: 'src/harness/tools.ts',
    },
    {
      code: "import '../%64river-x/types.js';",
      filename: 'src/harness/tools.ts',
    },
    {
      code: "const createRequire = () => (_source: string) => {}; createRequire()('../driver/types.js');",
      filename: 'src/harness/tools.ts',
    },
    {
      code: "type T = import('../shared/proc.js').ChildEnv;",
      filename: 'src/harness/tools.ts',
    },
    {
      code: "import proc = require('../shared/proc.js');",
      filename: 'src/harness/tools.ts',
    },
    {
      code: 'namespace Local { export type T = string; } import T = Local.T;',
      filename: 'src/harness/tools.ts',
    },
    {
      // The post-1.1 correct edges: harness consumes src/shared/**.
      code: "import { stripMetaSchema } from '../shared/json-schema.js';",
      filename: 'src/harness/surface.ts',
    },
    {
      code: "import { buildChildEnv } from '../shared/proc.js';",
      filename: 'src/harness/tools.ts',
    },
    {
      code: "export { terminateGracefully } from '../shared/proc.js';", // re-export sources checked too
      filename: 'src/harness/run.ts',
    },
    {
      // Intra-harness import.
      code: "import { buildTools } from './tools.js';",
      filename: 'src/harness/surface.ts',
    },
    {
      // src/sandbox is NOT the driver tree — allowed (tools.ts does this).
      code: "import { harnessRunGate } from '../sandbox/index.js';",
      filename: 'src/harness/tools.ts',
    },
    {
      code: "import { readFile } from 'node:fs/promises';", // node: builtins out of scope
      filename: 'src/harness/mcp/startup.ts',
    },
    {
      code: "import { z } from 'zod';", // bare specifiers out of scope
      filename: 'src/harness/config.ts',
    },
    {
      // Segment-boundary probe: src/driver-x is NOT src/driver.
      code: "import { x } from '../driver-x/types.js';",
      filename: 'src/harness/tools.ts',
    },
    {
      // Windows absolute importer path anchors at the LAST '/src/' segment.
      code: "import { buildChildEnv } from '../shared/proc.js';",
      filename: 'C:\\repo\\src\\harness\\tools.ts',
    },
    {
      code: "await import('../shared/proc.js');", // dynamic import, legal target
      filename: 'src/harness/tools.ts',
    },
    {
      // TS type-only import from an allowed root.
      code: "import type { HarnessConfig } from './config.js';",
      filename: 'src/harness/surface.ts',
    },
  ],
  invalid: [
    ...[
      "import '../%64river/types.js';",
      "export * from '../%64river/types.js?mode=test#part';",
      "await import('../shared/%2e%2e/%64river/types.js');",
      "type T = import('../%64river/types.js').SandboxLevel;",
      "import T = require('../%64river/types.js');",
    ].map((code) => ({
      code,
      filename: 'src/harness/tools.ts',
      errors: [{ messageId: 'driverImport' }],
    })),
    ...[
      "import '../%ZZdriver/types.js';",
      "import '../%E0%A4%A/types.js';",
      "import '../driver%2ftypes.js';",
      "import '../driver%5Ctypes.js';",
    ].map((code) => ({
      code,
      filename: 'src/harness/tools.ts',
      errors: [{ messageId: 'invalidSource' }],
    })),
    ...[
      "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('../driver/types.js');",
      "import { createRequire as makeLoader } from 'module'; makeLoader(import.meta.url)('../driver/types.js');",
      "import * as Module from 'node:module'; Module.createRequire(import.meta.url)('../driver/types.js');",
      "const { createRequire: makeLoader } = await import('node:module'); makeLoader(import.meta.url)('../driver/types.js');",
      "const { createRequire } = require('module'); const load = createRequire(import.meta.url); load('../driver/types.js');",
      "export { createRequire as loader } from 'node:module';",
    ].map((code) => ({
      code,
      filename: 'src/harness/tools.ts',
      errors: [{ messageId: 'moduleLoader' }],
    })),
    {
      code: "type T = import('../shared/../driver/types.js').SandboxLevel;",
      filename: 'src/harness/tools.ts',
      errors: [{ messageId: 'driverImport' }],
    },
    {
      code: "import driver = require('../driver/types.js');",
      filename: 'src/harness/tools.ts',
      errors: [{ messageId: 'driverImport' }],
    },
    {
      // The documented remaining violation shape (type-only driver/types).
      code: "import type { SandboxLevel, ToolPolicy } from '../driver/types.js';",
      filename: 'src/harness/surface.ts',
      errors: [{ messageId: 'driverImport' }],
    },
    {
      // The edge migration 1.1 kills: harness reaching the subprocess lane.
      code: "import { buildChildEnv } from '../driver/subprocess/process.js';",
      filename: 'src/harness/tools.ts',
      errors: [{ messageId: 'driverImport' }],
    },
    {
      // Deeper harness directory: '../../driver/…' still resolves into the tree.
      code: "import { buildChildEnv } from '../../driver/subprocess/process.js';",
      filename: 'src/harness/mcp/startup.ts',
      errors: [{ messageId: 'driverImport' }],
    },
    {
      // Traversal bypass probe: textually starts with '../shared/', resolves
      // to src/driver/types.js — resolve-then-contain catches it.
      code: "import { t } from '../shared/../driver/types.js';",
      filename: 'src/harness/tools.ts',
      errors: [{ messageId: 'driverImport' }],
    },
    {
      code: "export * from '../driver/types.js';", // re-export sources checked too
      filename: 'src/harness/surface.ts',
      errors: [{ messageId: 'driverImport' }],
    },
    {
      code: "await import('../driver/types.js');", // dynamic import, banned target
      filename: 'src/harness/surface.ts',
      errors: [{ messageId: 'driverImport' }],
    },
    {
      code: "const { x } = require('../driver/types.js');", // require sources checked too
      filename: 'src/harness/tools.ts',
      errors: [{ messageId: 'driverImport' }],
    },
    {
      // Windows absolute importer path still anchors and still reports.
      code: "import { buildChildEnv } from '../driver/subprocess/process.js';",
      filename: 'C:\\repo\\src\\harness\\tools.ts',
      errors: [{ messageId: 'driverImport' }],
    },
    {
      // FAIL CLOSED: a computed source hides its real target and is reported
      // outright (`const t = '../driver/types.js'; await import(t);`).
      code: "const t = '../driver/types.js';\nawait import(t);",
      filename: 'src/harness/tools.ts',
      errors: [{ messageId: 'computedSource' }],
    },
  ],
});
