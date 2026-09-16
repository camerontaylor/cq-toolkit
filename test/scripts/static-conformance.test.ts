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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'cq-static-conformance-'));
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
  ]) {
    cpSync(join(ROOT, file), join(root, file));
  }
  symlinkSync(
    join(ROOT, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'baselines/typecheck.json'), '{"count":0}\n');
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
  return spawnSync(process.execPath, ['scripts/ratchet-typecheck.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('real pinned compiler and lint conformance', () => {
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
    expect(result.stderr).toContain('4 error TS line(s) exceed baseline 0');
    for (const file of [
      'src/main.ts',
      'src/dependency.ts',
      'vitest.config.ts',
      'unvisited/extra.ts',
    ])
      expect(result.stderr).toContain(file);
  });
  it('passes the repaired project and rejects a missing module', () => {
    const root = fixture();
    const clean = gate(root);
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    writeFileSync(join(root, 'src/main.ts'), 'export { absent } from "./does-not-exist.js";\n');
    const missing = gate(root);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('TS2307');
  });
  it('fails project configuration errors even when updating a larger baseline', () => {
    const root = fixture();
    writeFileSync(join(root, 'baselines/typecheck.json'), '{"count":10}\n');
    writeFileSync(
      join(root, 'tsconfig.json'),
      '{"compilerOptions":{"notAnOption":true},"include":["src"]}',
    );
    const result = gate(root, ['--update']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('configuration or project-loading failure');
    expect(readFileSync(join(root, 'baselines/typecheck.json'), 'utf8')).toBe('{"count":10}\n');
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
  it('does not let --update hide a lint failure', () => {
    const root = fixture();
    writeFileSync(join(root, 'src/main.ts'), 'debugger; export {};\n');
    const result = gate(root, ['--update']);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('no-debugger');
    expect(readFileSync(join(root, 'baselines/typecheck.json'), 'utf8')).toBe('{"count":0}\n');
  });
});
