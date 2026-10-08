import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { copyRatchetEngine } from '../helpers/ratchet-fixture.js';
import { stripComments } from '../helpers/strip-comments.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DRIVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/driver');
const roots: string[] = [];
const BASELINE = 'baselines/typecheck--typecheck-count--7caef1e76077.json';

/**
 * The seam's one-directional import rule (ADR-0002), checked on the live
 * tree: NO file under src/driver may import src/kernel — statically or via
 * an import() expression. The kernel imports the seam, never the reverse;
 * the shipped conformance suite lives under src/driver and must satisfy the
 * same rule (its kernel-side leg, b-ii, lives in the test tree instead).
 */
function kernelImports(directory: string, root = directory): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      hits.push(...kernelImports(path, root));
    } else if (entry.name.endsWith('.ts')) {
      // Tokenize before matching (a JSDoc mention of a kernel module is
      // prose, not an import edge). The single-pass scanner keeps literal
      // contents VERBATIM — erasing them would erase the quoted specifiers
      // this scan matches on — while dropping both comment forms (block-
      // first regex passes once hid a live driver→kernel import behind a
      // `/*` inside a `//` comment). The specifier class covers
      // single/double quotes AND constant template literals (a backtick
      // import is still an import edge).
      const source = stripComments(readFileSync(path, 'utf8'));
      if (/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"`][^'"`]*\/kernel\//.test(source)) {
        // Relative to the scan root (kept through the recursion), so a
        // fixture scan names its files exactly like the live tree names.
        hits.push(path.slice(root.length + 1));
      }
    }
  }
  return hits.sort();
}

function fixture(prefix = 'cq-static-conformance-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  for (const directory of ['src', 'test', 'lint/rules', 'scripts', 'baselines', 'unvisited']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const file of [
    '.oxlintrc.json',
    'lint/plugin.mjs',
    'lint/rules/no-cli-beyond-registry-kernel.mjs',
    'lint/rules/no-vendor-sdk-in-kernel.mjs',
    'scripts/ratchet-typecheck.mjs',
    'scripts/ratchet-lib.mjs',
    BASELINE,
  ]) {
    cpSync(join(ROOT, file), join(root, file));
  }
  symlinkSync(
    join(ROOT, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2023',
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ['src', 'unvisited', 'vitest.config.ts'],
    }),
  );
  writeFileSync(join(root, 'vitest.config.ts'), 'export {};\n');
  writeFileSync(join(root, 'src/main.ts'), 'export const value: string = "ok";\n');
  return root;
}
function runGate(root: string, args: string[] = []) {
  return spawnSync(process.execPath, ['scripts/ratchet-typecheck.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
}
function gate(root: string, args: string[] = []) {
  copyRatchetEngine(ROOT, root);
  return runGate(root, args);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Real compiler/Oxlint calls have a bounded 30s child deadline below; the
// suite-level budget covers one bounded child under host-load swings, plus
// the one-off dist build copyRatchetEngine may pay when no global build ran. Cases
// with more bounded children (the TS2307 plus configuration-failure case runs
// three real gates; the integrated-omission case runs Oxlint then a gate)
// carry budgets covering every child bound, so a loaded host cannot fail
// before the structurally bounded child process reports.
describe('real pinned compiler and lint conformance', { timeout: 60_000 }, () => {
  it('finds no src/driver import of src/kernel — static or dynamic (the seam rule)', () => {
    expect(kernelImports(DRIVER_SRC)).toEqual([]);
  });
  it('the scan also catches a constant template-literal specifier (PR #238 review round 2)', () => {
    // A backtick import is still an import edge: the matcher accepts
    // single-quoted, double-quoted AND constant template-literal
    // specifiers, so ``await import(`…src/kernel/…`)`` cannot bypass the
    // driver-to-kernel seam guard.
    const scratch = mkdtempSync(join(tmpdir(), 'cq-kernel-import-tick-'));
    roots.push(scratch);
    writeFileSync(
      join(scratch, 'backtick.ts'),
      'const mod = await import(`../../src/kernel/types.js`);\nexport default mod;\n',
    );
    writeFileSync(
      join(scratch, 'quoted.ts'),
      "import x from '../../src/kernel/runner.js';\nexport default x;\n",
    );
    // A nested hit is named relative to the SCAN ROOT (the root threads
    // through the recursion), matching the live tree's naming.
    mkdirSync(join(scratch, 'nested'), { recursive: true });
    writeFileSync(
      join(scratch, 'nested', 'deep.ts'),
      'const mod = await import(`../../src/kernel/schema.js`);\nexport default mod;\n',
    );
    expect(kernelImports(scratch)).toEqual(['backtick.ts', join('nested', 'deep.ts'), 'quoted.ts']);
  });
  it('counts projected files, imported files, configs and inputs outside lint traversal', () => {
    const root = fixture();
    writeFileSync(
      join(root, 'src/main.ts'),
      '// oxlint-disable\ndebugger;\nimport "./dependency.js";\nexport const value: string = 42;\n',
    );
    writeFileSync(join(root, 'src/dependency.ts'), 'export const dependency: number = "bad";\n');
    writeFileSync(join(root, 'vitest.config.ts'), 'export const config: boolean = "bad";\n');
    writeFileSync(join(root, 'unvisited/extra.ts'), 'export const extra: string = 42;\n');
    const result = gate(root);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('baseline 0 → current 4');
    for (const file of [
      'src/main.ts',
      'src/dependency.ts',
      'vitest.config.ts',
      'unvisited/extra.ts',
    ])
      expect(result.stderr).toContain(file);
  });
  it('handles tool paths with spaces and shell metacharacters and rejects a missing module', () => {
    const root = fixture('cq static & conformance-');
    const clean = gate(root);
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    writeFileSync(join(root, 'src/main.ts'), 'export { absent } from "./does-not-exist.js";\n');
    const missing = gate(root);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('TS2307');

    // Keep the real TS configuration-error classifier live: a valid self-host
    // gate cannot exercise this branch, and the residual regex must be proved
    // against actual TypeScript diagnostics rather than hand-typed text.
    // Elevate the baseline so only the configuration classifier can fail the
    // gate: an ordinary below-baseline diagnostic count would pass.
    const original = readFileSync(join(root, BASELINE), 'utf8');
    writeFileSync(join(root, BASELINE), original.replace('"value": 0', '"value": 10'));
    writeFileSync(join(root, 'src/main.ts'), 'export const value: string = "ok";\n');
    writeFileSync(
      join(root, 'tsconfig.json'),
      '{"compilerOptions":{"notAnOption":true},"include":["src"]}',
    );
    const configFailure = gate(root);
    expect(configFailure.status).toBe(1);
    expect(readFileSync(join(root, BASELINE), 'utf8')).toBe(
      original.replace('"value": 0', '"value": 10'),
    );
    expect(configFailure.stderr).toContain('compiler configuration or project-loading failure:');
    expect(configFailure.stderr).toMatch(/TS5023|TS5083/);
  }, 100_000);
  it('reproduces the integrated checker omission that requires the compiler fallback', () => {
    const root = fixture();
    writeFileSync(join(root, 'unvisited/extra.ts'), 'export const extra: string = 42;\n');
    const integrated = spawnSync(
      process.execPath,
      [
        join(ROOT, 'node_modules/oxlint/bin/oxlint'),
        '--type-aware',
        '--type-check',
        '-f',
        'json',
        'src',
        'vitest.config.ts',
      ],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    );
    expect(integrated.status, integrated.stdout + integrated.stderr).toBe(0);
    expect(integrated.stdout).toContain('"diagnostics": []');
    const result = gate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unvisited/extra.ts');
  }, 70_000);
  it('rejects --update before loading the engine and never rewrites the baseline', () => {
    const root = fixture();
    const original = readFileSync(join(root, BASELINE), 'utf8');
    const update = runGate(root, ['--update']);
    expect(update.error).toBeUndefined();
    expect(update.status).toBe(1);
    expect(update.stderr).toContain('unsupported arguments');
    expect(readFileSync(join(root, BASELINE), 'utf8')).toBe(original);
  });
});
