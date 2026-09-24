import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeBin } from '../helpers/fake-bin.js';
import { copyRatchetEngine } from '../helpers/ratchet-fixture.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TMPDIR = realpathSync(tmpdir());
const roots: string[] = [];
function fixture(realTools = true): string {
  const root = mkdtempSync(join(TMPDIR, 'cq-command-contract-'));
  roots.push(root);
  for (const dir of ['src', 'test', 'lint', 'scripts/lib', 'baselines'])
    mkdirSync(join(root, dir), { recursive: true });
  for (const file of [
    '.oxlintrc.json',
    '.oxfmtrc.json',
    'scripts/fix.mjs',
    'scripts/lint-fast.mjs',
    'scripts/lib/owned-files.mjs',
    'scripts/ratchet-typecheck.mjs',
    'scripts/ratchet-lib.mjs',
    'baselines/typecheck--typecheck-count--7caef1e76077.json',
  ])
    cpSync(join(ROOT, file), join(root, file));
  cpSync(join(ROOT, 'lint'), join(root, 'lint'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'NodeNext',
        target: 'ES2023',
        skipLibCheck: true,
        types: [],
      },
      include: ['src', 'vitest.config.ts'],
    }),
  );
  writeFileSync(join(root, 'vitest.config.ts'), 'export {};\n');
  if (realTools)
    symlinkSync(
      join(ROOT, 'node_modules'),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  return root;
}
function command(
  root: string,
  script: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
) {
  if (script === 'ratchet-typecheck' || script === 'fix') copyRatchetEngine(ROOT, root);
  return spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('full static gate versus explicit-file fast lint', { timeout: 60_000 }, () => {
  it('asserts the compiler diagnostic and all four Oxlint diagnostics in two full gates', () => {
    // Fixture A isolates the compiler leg. Its real tsc failure short-circuits
    // the gate before Oxlint, exactly as the production ratchet does.
    const compilerRoot = fixture();
    const compilerFile = 'src/compiler.ts';
    writeFileSync(join(compilerRoot, compilerFile), 'export const value: string = 42;');
    const compilerFast = command(compilerRoot, 'lint-fast', [compilerFile]);
    expect(compilerFast.error).toBeUndefined();
    expect(compilerFast.status, compilerFast.stdout + compilerFast.stderr).toBe(0);
    const compilerFull = command(compilerRoot, 'ratchet-typecheck');
    expect(compilerFull.error).toBeUndefined();
    expect(compilerFull.status).toBe(1);
    expect(compilerFull.stdout + compilerFull.stderr).toContain('error TS2322');

    // Fixture B is tsc-clean, so one real full gate reaches Oxlint and emits
    // every type-aware and syntactic diagnostic across the four files.
    const oxlintRoot = fixture();
    const oxlintCases = [
      ['floating', 'src/floating.ts', 'Promise.resolve(42);', 'no-floating-promises', 0],
      [
        'unsafe',
        'src/unsafe.ts',
        'export const value: string = JSON.parse("42");',
        'no-unsafe-assignment',
        0,
      ],
      [
        'exhaustive',
        'src/exhaustive.ts',
        "export function f(x: 'a' | 'b') { switch(x) { case 'a': return 1; default: return 0; } }",
        'switch-exhaustiveness-check',
        0,
      ],
      ['syntactic', 'src/syntactic.ts', 'debugger;', 'no-debugger', 1],
    ] as const;
    for (const [, file, code] of oxlintCases) writeFileSync(join(oxlintRoot, file), code);

    for (const [, file, , , fastStatus] of oxlintCases) {
      const fast = command(oxlintRoot, 'lint-fast', [file]);
      expect(fast.error).toBeUndefined();
      expect(fast.status, fast.stdout + fast.stderr).toBe(fastStatus);
      if (file === 'src/syntactic.ts') expect(fast.stdout).toContain('no-debugger');
    }
    const oxlintFull = command(oxlintRoot, 'ratchet-typecheck');
    expect(oxlintFull.error).toBeUndefined();
    expect(oxlintFull.status).toBe(1);
    for (const [name, , , diagnostic] of oxlintCases) {
      expect(oxlintFull.stdout, name).toContain(diagnostic);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'fast mode never starts the failing checker shim; full mode does',
    () => {
      const root = fixture();
      writeFileSync(join(root, 'src/sample.ts'), 'Promise.resolve(42);');
      const shim = join(root, 'checker-shim.cjs');
      const marker = join(root, 'checker-started');
      writeFileSync(
        shim,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.exit(73);\n`,
      );
      chmodSync(shim, 0o755);
      const env = { ...process.env, OXLINT_TSGOLINT_PATH: shim };
      const fast = command(root, 'lint-fast', ['src/sample.ts'], env);
      expect(fast.status, fast.stdout + fast.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
      const full = command(root, 'ratchet-typecheck', [], env);
      expect(full.status).not.toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('started');
    },
  );
});

describe('owned-file command contract', { timeout: 60_000 }, () => {
  it('formats only the explicit file, handles spaces and shell characters literally, and checks dependents', () => {
    const root = fixture();
    const file = 'src/owned space;$.ts';
    writeFileSync(join(root, file), 'export const owned="ok"');
    writeFileSync(join(root, 'src/other.ts'), 'export const other: string = 42;\n');
    const original = readFileSync(join(root, 'src/other.ts'), 'utf8');
    const result = command(root, 'fix', [file, 'src/deleted.ts']);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('error TS2322');
    expect(readFileSync(join(root, file), 'utf8')).toBe("export const owned = 'ok';\n");
    expect(readFileSync(join(root, 'src/other.ts'), 'utf8')).toBe(original);
  });

  it('rejects empty lists, directories and outside paths before changing the first file', () => {
    const root = fixture();
    const file = join(root, 'src/owned.ts');
    const original = 'export const x="x"';
    writeFileSync(file, original);
    for (const args of [[], ['src/owned.ts', 'src'], ['src/owned.ts', '../outside.ts']]) {
      const result = command(root, 'fix', args);
      expect(result.status).toBe(1);
      expect(readFileSync(file, 'utf8')).toBe(original);
    }
    expect(command(root, 'lint-fast').status).toBe(1);
    expect(command(root, 'lint-fast', ['src/deleted.ts']).status).toBe(0);
  });

  it('rejects paths and missing leaves routed outside by a parent symlink', () => {
    const root = fixture();
    const outside = mkdtempSync(join(TMPDIR, 'cq-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'outside.ts'), 'debugger;');
    symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const file of ['linked/outside.ts', 'linked/deleted.ts'])
      expect(command(root, 'fix', [file]).status).toBe(1);
  });

  it('forwards safe fix argv, runs formatting after ordinary lint failures, and propagates tool failures', () => {
    const root = fixture(false);
    const file = join(root, 'src/owned space.ts');
    writeFileSync(file, 'export {};');
    const staticLog = join(root, 'static.calls.jsonl');
    const oxlint = installFakeBin(root, 'oxlint', {
      logFile: join(root, 'oxlint.calls.jsonl'),
      exitCodeEnv: 'OXLINT_EXIT',
    });
    const oxfmt = installFakeBin(root, 'oxfmt', {
      logFile: join(root, 'oxfmt.calls.jsonl'),
      exitCodeEnv: 'OXFMT_EXIT',
    });
    writeFileSync(
      join(root, 'scripts/ratchet-typecheck.mjs'),
      `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(staticLog)}, '["static"]\\n'); process.exit(17);`,
    );
    const result = command(root, 'fix', ['src/owned space.ts'], {
      ...process.env,
      OXLINT_EXIT: '1',
    });
    expect(result.status).toBe(17);
    const oxlintArgv = oxlint.calls()[0] ?? [];
    const oxfmtArgv = oxfmt.calls()[0] ?? [];
    const canonicalFile = realpathSync(file);
    expect([
      ['oxlint', ...oxlintArgv],
      ['oxfmt', ...oxfmtArgv],
    ]).toEqual([
      [
        'oxlint',
        '--config',
        realpathSync(join(root, '.oxlintrc.json')),
        '--disable-nested-config',
        '--fix',
        canonicalFile,
      ],
      ['oxfmt', canonicalFile],
    ]);
    expect(
      readFileSync(staticLog, 'utf8')
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line)),
    ).toEqual([['static']]);
    rmSync(staticLog);
    expect(
      command(root, 'fix', ['src/owned space.ts'], { ...process.env, OXFMT_EXIT: '8' }).status,
    ).toBe(1);
    expect(existsSync(staticLog)).toBe(false);
    writeFileSync(join(root, 'scripts/ratchet-typecheck.mjs'), 'process.exit(0);');
    expect(
      command(root, 'fix', ['src/owned space.ts'], { ...process.env, OXLINT_EXIT: '1' }).status,
    ).toBe(1);
    rmSync(join(root, 'node_modules/oxlint/bin/oxlint'));
    expect(command(root, 'lint-fast', ['src/owned space.ts']).status).not.toBe(0);
  });
});
