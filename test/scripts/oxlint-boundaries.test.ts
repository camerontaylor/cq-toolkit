import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(ROOT, 'node_modules/oxlint/bin/oxlint');
const roots: string[] = [];
function fixture(file: string, code: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cq-oxlint-boundary-'));
  roots.push(root);
  cpSync(join(ROOT, '.oxlintrc.json'), join(root, '.oxlintrc.json'));
  cpSync(join(ROOT, 'lint'), join(root, 'lint'), { recursive: true });
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), code);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  return root;
}
function lint(root: string, file: string) {
  return spawnSync(process.execPath, [BIN, '-f', 'json', file], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production Oxlint configuration and architecture plugin', () => {
  it.each([
    ['src/kernel/allowed.ts', "import 'zod';"],
    ['src/driver/implementation.ts', "import 'ai';"],
    ['src/cli/main.ts', "import '../registry/index.js'; import 'node:fs';"],
    ['src/cli/run-plan.ts', "import 'zod';"],
    ['src/cli.ts', "import './cli/main.js';"],
  ])('allows %s', (file, code) => {
    const result = lint(fixture(file, code), file);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
  it.each([
    ['src/kernel/banned.ts', "import 'ai';", 'no-vendor-sdk-in-kernel'],
    ['src/driver/types.ts', "export * from 'openai';", 'no-vendor-sdk-in-kernel'],
    ['src/cli/main.ts', "import '../ops/index.js';", 'no-cli-beyond-registry-kernel'],
    ['src/cli/main.ts', "import 'zod';", 'no-cli-beyond-registry-kernel'],
    [
      'src/cli/main.ts',
      "const source = '../kernel/types.js'; import(source);",
      'no-cli-beyond-registry-kernel',
    ],
    [
      'src/cli/main.ts',
      "type T = import('../driver/types.js').T; export type { T };",
      'no-cli-beyond-registry-kernel',
    ],
    ['src/cli.ts', "import './kernel/types.js';", 'no-cli-beyond-registry-kernel'],
  ])('rejects %s: %s', (file, code, rule) => {
    const result = lint(fixture(file, code), file);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(rule);
  });
  it.each(['missing-plugin', 'invalid-config'])('fails closed for %s', (failure) => {
    const root = fixture('src/kernel/a.ts', "import 'ai';");
    if (failure === 'missing-plugin') rmSync(join(root, 'lint/plugin.mjs'));
    else writeFileSync(join(root, '.oxlintrc.json'), '{broken');
    const result = lint(root, 'src/kernel/a.ts');
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
  });
  it.each(['scripts/example.mjs', 'vitest.config.ts'])('checks maintained %s', (file) => {
    const result = lint(fixture(file, 'debugger;'), file);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('no-debugger');
  });
});
