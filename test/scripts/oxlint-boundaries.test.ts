import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
function diagnosticsOf(
  result: ReturnType<typeof lint>,
): Array<{ filename: string; code: string; labels?: Array<{ span?: { line?: number } }> }> {
  const parsed = JSON.parse(result.stdout) as {
    diagnostics: Array<{
      filename: string;
      code: string;
      labels?: Array<{ span?: { line?: number } }>;
    }>;
  };
  return parsed.diagnostics;
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

  it('keeps the real harness tree at exactly the documented driver-import violations', () => {
    const result = spawnSync(process.execPath, [BIN, '-f', 'json', 'src/harness'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const violations = diagnosticsOf(result)
      .filter((entry) => entry.code.includes('no-driver-import-in-harness'))
      .map((entry) => entry.filename.replace(`${ROOT}/`, ''))
      .sort();
    // The rule header documents these two type-only src/driver/types.ts
    // imports (they become contracts imports in a later migration step).
    // This assertion makes the documentation a ratchet: a NEW harness→
    // driver import fails here instead of silently joining the warn list.
    expect(violations).toEqual(['src/harness/surface.ts', 'src/harness/tools.ts']);
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
