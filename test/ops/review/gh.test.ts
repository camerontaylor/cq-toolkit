// E1 round-2/round-3 — the gh runner's process contract: UTF-8 decoded ONCE
// over the whole stream (a multi-byte character split across two pipe chunks
// survives; chunk-wise decoding would replace it with U+FFFD), a missing
// binary resolves fail-closed with code 127 (the seam never rejects), ghJson
// rejects non-JSON stdout, and timeoutMs bounds a hung child with the
// timeout convention code 124 + stderr marker — resolving, not throwing.
//
// The spawned helpers are generated at runtime into a temp dir (not repo
// fixtures) and run through the real makeGhRunner seam.
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { makeGhRunner, ghJson } from '../../../src/adapters/forge-github/gh.js';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';
import {
  ghMergeEnv,
  ghSpawnEnv,
  resolveWindowsCommand,
} from '../../../src/adapters/forge-github/ghBin.js';
import { makeSubprocessPrEffects } from '../../../src/adapters/forge-github/ghEffects.js';

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

  test('bare binary resolves explicit relative PATH against caller cwd, never child cwd', async () => {
    const trusted = await tempBin('cq-gh-path-probe', '#!/bin/sh\nprintf trusted');
    const childDir = await mkdtemp(join(tmpdir(), 'cq-gh-scoped-'));
    tempDirs.push(childDir);
    await writeFile(join(childDir, 'cq-gh-path-probe'), '#!/bin/sh\nprintf hostile', {
      mode: 0o755,
    });
    const result = await makeGhRunner({
      bin: 'cq-gh-path-probe',
      cwd: childDir,
      env: { PATH: `${relative(process.cwd(), dirname(trusted))}${delimiter}/bin` },
    })([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('trusted');
    const missing = await makeGhRunner({
      bin: 'cq-gh-path-probe',
      cwd: childDir,
      env: { PATH: '' },
    })([]);
    expect(missing.code).toBe(127);
    expect(missing.stdout).toBe('');
  });

  test('PR effects do not resolve gh from the scoped repository', async () => {
    const trusted = await tempBin('gh', `#!/bin/sh\nprintf '{"body":"trusted"}'`);
    const childDir = await mkdtemp(join(tmpdir(), 'cq-gh-effects-'));
    tempDirs.push(childDir);
    await writeFile(join(childDir, 'gh'), `#!/bin/sh\nprintf '{"body":"hostile"}'`, {
      mode: 0o755,
    });
    const oldPath = process.env.PATH;
    const oldGh = process.env.CQ_GH_BIN;
    try {
      process.env.PATH = `.${delimiter}${dirname(trusted)}`;
      delete process.env.CQ_GH_BIN;
      expect(await makeSubprocessPrEffects(childDir).getPrBody(1)).toBe('trusted');
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldGh === undefined) delete process.env.CQ_GH_BIN;
      else process.env.CQ_GH_BIN = oldGh;
    }
  });

  test('Windows explicit environment overrides inherited keys case-insensitively', () => {
    expect(
      ghMergeEnv({ PATH: 'inherited', Other: 'value' }, { Path: 'explicit' }, 'win32'),
    ).toEqual({ Path: 'explicit', Other: 'value' });
  });

  test('Windows executable resolution searches caller PATH without consulting child cwd', async () => {
    const trusted = await tempBin('cq-windows-probe.exe', 'placeholder');
    const found = resolveWindowsCommand('cq-windows-probe', { Path: dirname(trusted) }, 'win32');
    expect(found).toBe(trusted);
    const missing = resolveWindowsCommand(
      'cq-windows-missing',
      { Path: dirname(trusted) },
      'win32',
    );
    expect(missing).toBeUndefined();
  });

  test('Windows PATH quoting and semicolons are anchored without lexical normalization', () => {
    const env = ghSpawnEnv(
      { Path: `"C:\\Program Files\\a;b";'rel;part';C:\\x\\..\\bin` },
      'win32',
      'C:\\caller',
    );
    expect(env.Path).toBe(`"C:\\Program Files\\a;b";"C:\\caller\\rel;part";C:\\x\\..\\bin`);
  });

  test('Windows current-directory opt-out skips the cwd probe', () => {
    const seen: string[] = [];
    const result = resolveWindowsCommand(
      'gh',
      { Path: '/trusted' },
      'win32',
      { NoDefaultCurrentDirectoryInExePath: '' },
      '/caller',
      (candidate) => {
        seen.push(candidate);
        return candidate === '/trusted/gh.exe';
      },
    );
    expect(result).toBe('/trusted/gh.exe');
    expect(seen.every((candidate) => !candidate.startsWith('/caller/'))).toBe(true);
  });

  test.skipIf(process.platform === 'win32')(
    'preserves symlink traversal in PATH entries',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'cq-gh-symlink-'));
      tempDirs.push(root);
      await mkdir(join(root, 'other', 'deep'), { recursive: true });
      await mkdir(join(root, 'other', 'bin'));
      await mkdir(join(root, 'bin'));
      await symlink(join(root, 'other', 'deep'), join(root, 'link'));
      await writeFile(join(root, 'other', 'bin', 'cq-symlink-probe'), '#!/bin/sh\nprintf correct', {
        mode: 0o755,
      });
      await writeFile(join(root, 'bin', 'cq-symlink-probe'), '#!/bin/sh\nprintf wrong', {
        mode: 0o755,
      });
      for (const path of [`${root}/link/../bin`, `${relative(process.cwd(), root)}/link/../bin`]) {
        const result = await makeGhRunner({ bin: 'cq-symlink-probe', env: { PATH: path } })([]);
        expect(result.stdout).toBe('correct');
      }
    },
  );

  test('PATH search continues past an executable with a missing interpreter', async () => {
    const broken = await tempBin('cq-gh-search-probe', '#!/no-such-interpreter\n');
    const working = await tempBin('cq-gh-search-probe', '#!/bin/sh\nprintf fallback');
    const result = await makeGhRunner({
      bin: 'cq-gh-search-probe',
      env: { PATH: `${dirname(broken)}${delimiter}${dirname(working)}` },
    })([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('fallback');
  });

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
