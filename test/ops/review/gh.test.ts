// E1 round-2/round-3 — the gh runner's process contract: UTF-8 decoded ONCE
// over the whole stream (a multi-byte character split across two pipe chunks
// survives; chunk-wise decoding would replace it with U+FFFD), a missing
// binary resolves fail-closed with code 127 (the seam never rejects), ghJson
// rejects non-JSON stdout, and timeoutMs bounds a hung child with the
// timeout convention code 124 + stderr marker — resolving, not throwing.
//
// The spawned helpers are generated at runtime into a temp dir (not repo
// fixtures) and run through the real makeGhRunner seam.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { makeGhRunner, ghJson } from '../../../src/ops/review/gh.js';
import type { GhFn } from '../../../src/ops/review/gh.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Write an executable helper .mjs into a fresh temp dir and return its path. */
const tempBin = async (name: string, source: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'cq-gh-'));
  tempDirs.push(dir);
  const bin = join(dir, name);
  await writeFile(bin, source);
  await chmod(bin, 0o755);
  return bin;
};

describe('makeGhRunner', () => {
  test('a multi-byte UTF-8 character split across two pipe chunks survives', async () => {
    const bin = await tempBin(
      'split-writer.mjs',
      [
        '#!/usr/bin/env node',
        'import process from "node:process";',
        'process.stdout.write(Buffer.from([0x61, 0xe6, 0x97]));',
        'setTimeout(() => {',
        '  process.stdout.write(Buffer.from([0xa5, 0x62]));',
        '  process.exit(0);',
        '}, 20);',
        '',
      ].join('\n'),
    );
    const run = makeGhRunner({ bin });
    const res = await run([]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('a\u65e5b');
  }, 10_000);

  test('unsetEnv strips an INHERITED name; an explicit env entry survives the strip (review-debt #163)', async () => {
    const previousProbeRepo = process.env.CQ_GH_PROBE_REPO;
    process.env.CQ_GH_PROBE_REPO = 'inherited/wrong-repo';
    const bin = await tempBin(
      'env-echo.mjs',
      [
        '#!/usr/bin/env node',
        'import process from "node:process";',
        `process.stdout.write(String(process.env.CQ_GH_PROBE_REPO ?? ''));`,
        '',
      ].join('\n'),
    );
    try {
      // Inherited + stripped: the child sees nothing.
      const stripped = await makeGhRunner({ bin, unsetEnv: ['CQ_GH_PROBE_REPO'] })([]);
      expect(stripped.stdout).toBe('');
      // Explicit env of the same name is caller intent and SURVIVES the strip.
      const explicit = await makeGhRunner({
        bin,
        env: { CQ_GH_PROBE_REPO: 'explicit/kept' },
        unsetEnv: ['CQ_GH_PROBE_REPO'],
      })([]);
      expect(explicit.stdout).toBe('explicit/kept');
    } finally {
      if (previousProbeRepo === undefined) delete process.env.CQ_GH_PROBE_REPO;
      else process.env.CQ_GH_PROBE_REPO = previousProbeRepo;
    }
  }, 10_000);

  test('a RELATIVE separator-bearing bin resolves against the process cwd, not a scoped opts.cwd (review-debt #163)', async () => {
    const bin = await tempBin(
      'relative-probe.mjs',
      [
        '#!/usr/bin/env node',
        'import process from "node:process";',
        'process.stdout.write("resolved-ok");',
        '',
      ].join('\n'),
    );
    const rel = `./${relative(process.cwd(), bin)}`;
    // The spawn cwd is a DIFFERENT directory: if the bin resolved there the
    // run would 127 — resolving against the process cwd (the pre-scoping
    // semantics) finds the probe.
    const elsewhere = await mkdtemp(join(tmpdir(), 'cq-gh-elsewhere-'));
    tempDirs.push(elsewhere);
    const run = makeGhRunner({ bin: rel, cwd: elsewhere });
    const res = await run([]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('resolved-ok');
  }, 10_000);

  test('a nonexistent binary resolves (never rejects) with the 127 convention', async () => {
    const run = makeGhRunner({ bin: '/nonexistent-cq-gh-probe' });
    const res = await run(['whatever']);
    expect(res.code).toBe(127);
    expect(res.stderr).not.toBe('');
  }, 10_000);

  test('timeoutMs SIGKILLs a hung child: resolves code 124 with the stderr marker, timer cleared', async () => {
    const bin = await tempBin(
      'sleeper.mjs',
      [
        '#!/usr/bin/env node',
        'import process from "node:process";',
        'setTimeout(() => process.exit(0), 5000);',
        '',
      ].join('\n'),
    );
    const run = makeGhRunner({ bin, timeoutMs: 100 });
    const startedAt = Date.now();
    const res = await run([]); // resolves — the seam stays total
    const elapsed = Date.now() - startedAt;
    expect(res.code).toBe(124);
    expect(res.stderr).toContain('gh timed out after 100ms');
    // The child was killed and the timer cleared: we are back long before
    // the child's own 5s exit, and the process is not kept alive by the
    // pending timer.
    expect(elapsed).toBeLessThan(4000);
  }, 10_000);
});

describe('ghJson', () => {
  test('non-JSON stdout rejects with a non-JSON message (never echoes the stdout)', async () => {
    const run: GhFn = async () => ({ code: 0, stdout: 'not json', stderr: '' });
    await expect(ghJson(run, ['api', 'x'])).rejects.toThrow(/non-JSON/);
  });
});
