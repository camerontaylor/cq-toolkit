import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

it('rejects an unwired source file and passes once the SDK imports it', () => {
  const root = mkdtempSync(join(tmpdir(), 'cq-knip-'));
  try {
    mkdirSync(join(root, 'src'));
    cpSync(join(ROOT, 'knip.json'), join(root, 'knip.json'));
    writeFileSync(join(root, 'package.json'), '{"name":"knip-fixture","type":"module"}');
    writeFileSync(join(root, 'src/index.ts'), 'export {};\n');
    writeFileSync(join(root, 'src/forgotten.ts'), 'export const value = 42;\n');
    const run = () =>
      spawnSync(process.execPath, [join(ROOT, 'node_modules/knip/bin/knip.js'), '--no-progress'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      });
    const broken = run();
    expect(broken.error).toBeUndefined();
    expect(broken.status).toBe(1);
    expect(broken.stdout + broken.stderr).toContain('src/forgotten.ts');
    writeFileSync(join(root, 'src/index.ts'), "export { value } from './forgotten.js';\n");
    const repaired = run();
    expect(repaired.error).toBeUndefined();
    expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
