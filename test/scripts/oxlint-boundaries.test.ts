import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(ROOT, 'node_modules/oxlint/bin/oxlint');
const roots: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cq-oxlint-boundary-'));
  roots.push(root);
  cpSync(join(ROOT, '.oxlintrc.json'), join(root, '.oxlintrc.json'));
  cpSync(join(ROOT, 'lint'), join(root, 'lint'), { recursive: true });
  for (const [file, code] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), code);
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  return root;
}
function lint(root: string, files: string[]) {
  return spawnSync(process.execPath, [BIN, '-f', 'json', ...files], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });
}
function diagnosticsOf(result: ReturnType<typeof lint>): Array<{
  filename: string;
  code: string;
  labels?: Array<{ span?: { line?: number; column?: number } }>;
}> {
  const parsed = JSON.parse(result.stdout) as {
    diagnostics: Array<{
      filename: string;
      code: string;
      labels?: Array<{ span?: { line?: number; column?: number } }>;
    }>;
  };
  return parsed.diagnostics;
}
// Exact statement text includes the source, declaration/import kind and named
// bindings; the diagnostic coordinates anchor that shape at its allowed site.
// Counting only filenames would let a runtime or different-module import replace
// one documented type-only import without increasing the warning count.
function harnessViolations(result: ReturnType<typeof lint>, root: string) {
  return diagnosticsOf(result)
    .filter((entry) => entry.code.includes('no-driver-import-in-harness'))
    .map((entry) => {
      const filename = entry.filename.replace(`${root}/`, '');
      const span = entry.labels?.[0]?.span;
      const lines = readFileSync(join(root, filename), 'utf8').split('\n');
      return {
        filename,
        line: span?.line,
        column: span?.column,
        statement: lines[(span?.line ?? 0) - 1],
      };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production Oxlint configuration and architecture plugin', () => {
  it('checks all allowed files in one real run', () => {
    const files: Record<string, string> = {
      'src/kernel/allowed.ts': "import 'zod';",
      'src/driver/implementation.ts': "import 'ai';",
      'src/cli/main.ts': "import '../registry/index.js'; import 'node:fs';",
      'src/cli/run-plan.ts': "import 'zod';",
      'src/cli.ts': "import './cli/main.js';",
    };
    const result = lint(fixture(files), Object.keys(files));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(diagnosticsOf(result)).toEqual([]);
  });

  it('checks all rejected files and attributes each rule from one real run', () => {
    const files: Record<string, string> = {
      'src/kernel/banned.ts': "import 'ai';",
      'src/driver/types.ts': "export * from 'openai';",
      'src/cli/main.ts': [
        "import '../ops/index.js';",
        "import 'zod';",
        "const source = '../kernel/types.js'; import(source);",
        "type T = import('../driver/types.js').T; export type { T };",
      ].join('\n'),
      'src/cli.ts': "import './kernel/types.js';",
      'scripts/example.mjs': 'debugger;',
      'vitest.config.ts': 'debugger;',
    };
    const result = lint(fixture(files), Object.keys(files));
    expect(result.status).toBe(1);
    const diagnostics = diagnosticsOf(result);
    for (const [file, rules] of Object.entries({
      'src/kernel/banned.ts': ['no-vendor-sdk-in-kernel'],
      'src/driver/types.ts': ['no-vendor-sdk-in-kernel'],
      'src/cli/main.ts': ['no-cli-beyond-registry-kernel'],
      'src/cli.ts': ['no-cli-beyond-registry-kernel'],
      'scripts/example.mjs': ['no-debugger'],
      'vitest.config.ts': ['no-debugger'],
    })) {
      for (const rule of rules) {
        expect(
          diagnostics.some((entry) => entry.filename === file && entry.code.includes(rule)),
          `${file}: ${rule}`,
        ).toBe(true);
      }
    }
    const cliBoundaryDiagnostics = diagnostics.filter(
      (entry) =>
        entry.filename === 'src/cli/main.ts' &&
        entry.code.includes('no-cli-beyond-registry-kernel'),
    );
    expect(new Set(cliBoundaryDiagnostics.map((entry) => entry.labels?.[0]?.span?.line))).toEqual(
      new Set([1, 2, 3, 4]),
    );
    expect(cliBoundaryDiagnostics).toHaveLength(4);
  });

  it('warns on harness driver imports without failing the run (warn-mode boundary)', () => {
    const files: Record<string, string> = {
      'src/harness/surface.ts': [
        "import type { SandboxLevel } from '../driver/types.js';", // violation (warn)
        "import { stripMetaSchema } from '../shared/json-schema.js';", // the legal edge
        'export type { SandboxLevel };', // use both imports: only the boundary rule may fire
        'export const stripped = stripMetaSchema({});',
        "export type Inline = import('../driver/types.js').SandboxLevel;",
        "import Driver = require('../driver/types.js');",
        'export type Required = Driver.SandboxLevel;',
      ].join('\n'),
    };
    const result = lint(fixture(files), Object.keys(files));
    // WARN severity: diagnostics are reported but the run does not fail —
    // the migration-1.1 boundary hardens to error only in a later lane.
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const harness = diagnosticsOf(result).filter((entry) =>
      entry.code.includes('no-driver-import-in-harness'),
    );
    expect(harness).toHaveLength(3);
    expect(harness[0]?.filename).toBe('src/harness/surface.ts');
    expect(new Set(harness.map((entry) => entry.labels?.[0]?.span?.line))).toEqual(
      new Set([1, 5, 6]),
    );
  });

  it('warns on escaped paths and module-loader bridges in the real config', () => {
    const files: Record<string, string> = {
      'src/harness/escaped.ts': [
        "import '../%64river/types.js';",
        "export * from '../shared/%2e%2e/%64river/types.js?mode=test#part';",
        "import '../driver%2ftypes.js';",
        "import '../driver%5Ctypes.js';",
        "import '../%ZZdriver/types.js';",
      ].join('\n'),
      'src/harness/aliased.ts': [
        "import { createRequire as makeLoader } from 'node:module';",
        'const load = makeLoader(import.meta.url);',
        "export const driver = load('../driver/types.js');",
      ].join('\n'),
      'src/harness/direct.ts': [
        "import * as Module from 'module';",
        "export const driver = Module.createRequire(import.meta.url)('../driver/types.js');",
      ].join('\n'),
      'src/harness/dynamic.ts': [
        "const { createRequire } = await import('node:module');",
        "export const driver = createRequire(import.meta.url)('../driver/types.js');",
      ].join('\n'),
    };
    const root = fixture(files);
    const result = lint(root, Object.keys(files));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const violations = harnessViolations(result, root);
    expect(violations.map(({ filename, line }) => [filename, line])).toEqual([
      ['src/harness/aliased.ts', 1],
      ['src/harness/direct.ts', 1],
      ['src/harness/dynamic.ts', 1],
      ['src/harness/escaped.ts', 1],
      ['src/harness/escaped.ts', 2],
      ['src/harness/escaped.ts', 3],
      ['src/harness/escaped.ts', 4],
      ['src/harness/escaped.ts', 5],
    ]);
  });

  it.each([
    "import { SandboxLevel, ToolPolicy } from '../driver/types.js';",
    "import type { SandboxLevel, ToolPolicy } from '../driver/other.js';",
    "import type { SandboxLevel, ToolDenial } from '../driver/types.js';",
    "\nimport type { SandboxLevel, ToolPolicy } from '../driver/types.js';",
  ])('distinguishes a changed documented import despite an unchanged warning count: %s', (code) => {
    const filename = 'src/harness/surface.ts';
    const root = fixture({ [filename]: code + '\nexport type { SandboxLevel };' });
    const result = lint(root, [filename]);
    expect(result.error).toBeUndefined();
    const violations = harnessViolations(result, root);
    expect(violations).toHaveLength(1);
    expect(violations).not.toEqual([
      {
        filename,
        line: 1,
        column: 1,
        statement: "import type { SandboxLevel, ToolPolicy } from '../driver/types.js';",
      },
    ]);
  });

  it('keeps the real harness tree at exactly the documented driver-import violations', () => {
    const result = spawnSync(process.execPath, [BIN, '-f', 'json', 'src/harness'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const violations = harnessViolations(result, ROOT);
    // The rule header documents these two type-only src/driver/types.ts
    // imports (they become contracts imports in a later migration step).
    // This assertion makes the documentation a ratchet: a NEW harness→
    // driver import fails here instead of silently joining the warn list.
    expect(violations).toEqual([
      {
        filename: 'src/harness/surface.ts',
        line: 43,
        column: 1,
        statement: "import type { SandboxLevel, ToolPolicy } from '../driver/types.js';",
      },
      {
        filename: 'src/harness/tools.ts',
        line: 129,
        column: 1,
        statement: "import type { SandboxLevel, ToolDenial } from '../driver/types.js';",
      },
    ]);
  });

  it.each(['missing-plugin', 'invalid-config'])('fails closed for %s', (failure) => {
    const root = fixture({ 'src/kernel/a.ts': "import 'ai';" });
    if (failure === 'missing-plugin') rmSync(join(root, 'lint/plugin.mjs'));
    else writeFileSync(join(root, '.oxlintrc.json'), '{broken');
    const result = lint(root, ['src/kernel/a.ts']);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
  });
});
