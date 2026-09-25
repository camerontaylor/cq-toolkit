import { spawnSync } from 'node:child_process';
import {
  cpSync,
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
const BASELINE = 'baselines/typecheck--typecheck-count--7caef1e76077.json';
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
function gate(root: string, args: string[] = []) {
  copyRatchetEngine(ROOT, root);
  return spawnSync(process.execPath, ['scripts/ratchet-typecheck.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Each test spawns the real pinned TypeScript compiler and oxlint via the static gate.
describe('real pinned compiler and lint conformance', { timeout: 60_000 }, () => {
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
  });
  it('fails project configuration errors even with a larger baseline', () => {
    const root = fixture();
    const original = readFileSync(join(root, BASELINE), 'utf8').replace(
      '"value": 0',
      '"value": 10',
    );
    writeFileSync(join(root, BASELINE), original);
    writeFileSync(
      join(root, 'tsconfig.json'),
      '{"compilerOptions":{"notAnOption":true},"include":["src"]}',
    );
    const result = gate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('configuration or project-loading failure');
    expect(readFileSync(join(root, BASELINE), 'utf8')).toBe(original);
  });
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
  });
  it('rejects lint failures and never lets --update rewrite the baseline', () => {
    const root = fixture();
    writeFileSync(join(root, 'src/main.ts'), 'debugger; export {};\n');
    const original = readFileSync(join(root, BASELINE), 'utf8');
    const result = gate(root);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('no-debugger');
    const update = gate(root, ['--update']);
    expect(update.status).toBe(1);
    expect(update.stderr).toContain('unsupported arguments');
    expect(readFileSync(join(root, BASELINE), 'utf8')).toBe(original);
  });
});
