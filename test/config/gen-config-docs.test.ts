// The static gate's drift check: `gen-config-docs --check` fails on a stale table.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'gen-config-docs.mjs');
const DOC = join(ROOT, 'docs', 'config.md');

const check = (out: string) =>
  spawnSync(process.execPath, [SCRIPT, '--check', `--out=${out}`], { encoding: 'utf8' });

describe('gen-config-docs --check', () => {
  test('passes on the committed table and fails when it is stale or missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gen-config-docs-'));
    try {
      expect(check(DOC).status, check(DOC).stderr).toBe(0);
      const stale = join(dir, 'config.md');
      writeFileSync(stale, readFileSync(DOC, 'utf8').replace('CQ_GH_BIN', 'CQ_GH_BINX'));
      const res = check(stale);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('out of date');
      expect(check(join(dir, 'missing.md')).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
