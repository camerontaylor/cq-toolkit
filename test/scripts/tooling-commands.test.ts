import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { copyRatchetEngine } from '../helpers/ratchet-fixture.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const roots: string[] = [];
function fixture(realTools = true): string {
  const root = mkdtempSync(join(tmpdir(), 'cq-command-contract-'));
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
  it.each([
    ['compiler', 'export const value: string = 42;', 'error TS2322', 0],
    ['floating', 'Promise.resolve(42);', 'no-floating-promises', 0],
    ['unsafe', 'export const value: string = JSON.parse("42");', 'no-unsafe-assignment', 0],
    [
      'exhaustive',
      "export function f(x: 'a' | 'b') { switch(x) { case 'a': return 1; default: return 0; } }",
      'switch-exhaustiveness-check',
      0,
    ],
    ['syntactic', 'debugger;', 'no-debugger', 1],
  ])('%s failure is enforced in the appropriate mode', (_name, code, diagnostic, fastStatus) => {
    const root = fixture();
    writeFileSync(join(root, 'src/sample.ts'), code);
    const fast = command(root, 'lint-fast', ['src/sample.ts']);
    expect(fast.error).toBeUndefined();
    expect(fast.status, fast.stdout + fast.stderr).toBe(fastStatus);
    const full = command(root, 'ratchet-typecheck');
    expect(full.error).toBeUndefined();
    expect(full.status).toBe(1);
    expect(full.stdout + full.stderr).toContain(diagnostic);
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
    const outside = mkdtempSync(join(tmpdir(), 'cq-outside-'));
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
    const log = join(root, 'calls.jsonl');
    for (const tool of ['oxlint', 'oxfmt']) {
      const bin = join(root, 'node_modules', tool, 'bin', tool);
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(
        bin,
        `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(tool)}, ...process.argv.slice(2)])+'\\n'); process.exit(Number(process.env.${tool.toUpperCase()}_EXIT ?? 0));`,
      );
    }
    writeFileSync(
      join(root, 'scripts/ratchet-typecheck.mjs'),
      `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, '["static"]\\n'); process.exit(17);`,
    );
    const result = command(root, 'fix', ['src/owned space.ts'], {
      ...process.env,
      OXLINT_EXIT: '1',
    });
    expect(result.status).toBe(17);
    const calls: unknown = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(calls).toEqual([
      [
        'oxlint',
        '--config',
        join(root, '.oxlintrc.json'),
        '--disable-nested-config',
        '--fix',
        file,
      ],
      ['oxfmt', file],
      ['static'],
    ]);
    rmSync(log);
    expect(
      command(root, 'fix', ['src/owned space.ts'], { ...process.env, OXFMT_EXIT: '8' }).status,
    ).toBe(1);
    expect(readFileSync(log, 'utf8')).not.toContain('static');
    writeFileSync(join(root, 'scripts/ratchet-typecheck.mjs'), 'process.exit(0);');
    expect(
      command(root, 'fix', ['src/owned space.ts'], { ...process.env, OXLINT_EXIT: '1' }).status,
    ).toBe(1);
    rmSync(join(root, 'node_modules/oxlint/bin/oxlint'));
    expect(command(root, 'lint-fast', ['src/owned space.ts']).status).not.toBe(0);
  });
});
