// Split provenance: test/ops/pr/registry.test.ts was split into the
// registry.*.test.ts subject files plus registry.helpers.ts; this file keeps
// the execFile fault taxonomy (mapGhFault), the inert-construction pin, and
// the spawn-env repo-binding pin.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  makeSubprocessPrEffects,
  mapGhFault,
} from '../../../src/adapters/forge-github/ghEffects.js';

describe('mapGhFault (the execFile fault taxonomy)', () => {
  const ARGS = ['pr', 'view', '7'];

  test('a maxBuffer overflow is named a size limit, not a timeout', () => {
    const fault = mapGhFault(
      ARGS,
      { message: 'stdout maxBuffer length exceeded', killed: true },
      '',
      600_000,
    );
    expect(fault.message).toContain('exceeded the output limit');
    expect(fault.message).toContain('maxBuffer');
    expect(fault.message).not.toContain('timed out');
  });

  test('a SIGKILLed call is named a timeout that never produced evidence', () => {
    const fault = mapGhFault(ARGS, { message: 'command failed', killed: true }, '', 600_000);
    expect(fault.message).toContain('timed out after 600000ms');
    expect(fault.message).toContain('never produced evidence');
  });

  test('a plain nonzero exit carries the exit code and the captured stderr', () => {
    const fault = mapGhFault(
      ARGS,
      { message: 'command failed', killed: false, code: 4 },
      'GraphQL: Could not resolve to a PullRequest',
      600_000,
    );
    expect(fault.message).toContain('gh pr view (exit 4) failed');
    expect(fault.message).toContain('Could not resolve to a PullRequest');
  });

  test('a spawn failure without stderr falls back to the error message', () => {
    const fault = mapGhFault(
      ARGS,
      { message: 'spawn gh ENOENT', killed: false, code: 127 },
      '  ',
      600_000,
    );
    expect(fault.message).toContain('spawn gh ENOENT');
  });
});

describe('makeSubprocessPrEffects construction is inert', () => {
  test('the adapter is a closure set — no gh spawn at construction time', () => {
    // Construction must not touch env/network/filesystem (the importer
    // resolves it); the effects spawn only when CALLED.
    const effects = makeSubprocessPrEffects('/repo');
    expect(typeof effects.searchPrByHead).toBe('function');
    expect(typeof effects.createPr).toBe('function');
  });
});

describe('makeSubprocessPrEffects spawn env — repoRoot is the only repo selector', () => {
  test('an inherited GH_REPO never reaches the child (gh: -R > GH_REPO > cwd)', async () => {
    // gh resolves its repository as `-R` > `GH_REPO` > cwd. This adapter
    // carries no `-R`; it binds the repository through the spawn cwd alone,
    // so a parent `GH_REPO` (e.g. `other/repo`) would silently aim
    // editPrBody/comment/createPr at ANOTHER repository. The child env must
    // therefore see NO GH_REPO, while the spawn still runs inside repoRoot.
    const scratch = await mkdtemp(join(tmpdir(), 'cq-pr-ghrepo-'));
    const binDir = join(scratch, 'bin');
    const repoDir = join(scratch, 'repo');
    const ghRepoFile = join(scratch, 'ghrepo');
    const cwdFile = join(scratch, 'cwd');
    try {
      await mkdir(binDir, { recursive: true });
      await mkdir(repoDir, { recursive: true });
      await writeFile(
        join(binDir, 'gh'),
        [
          '#!/bin/sh',
          `printf '%s' "\${GH_REPO-unset}" > '${ghRepoFile}'`,
          `printf '%s' "$PWD" > '${cwdFile}'`,
          `echo '{"body":"x"}'`,
          '',
        ].join('\n'),
      );
      await chmod(join(binDir, 'gh'), 0o755);
      const originalPath = process.env['PATH'];
      const originalGhRepo = process.env['GH_REPO'];
      const originalGhBin = process.env['CQ_GH_BIN'];
      process.env['PATH'] = `${binDir}:${originalPath ?? ''}`;
      process.env['GH_REPO'] = 'other/repo';
      // An inherited CQ_GH_BIN would bypass the fake gh on PATH.
      delete process.env['CQ_GH_BIN'];
      try {
        const effects = makeSubprocessPrEffects(repoDir);
        await expect(effects.getPrBody(123)).resolves.toBe('x');
        expect(await readFile(ghRepoFile, 'utf8')).toBe('unset');
        // Compare REAL paths: os.tmpdir() may hand out a symlinked spelling.
        const { realpath: realpathFsp } = await import('node:fs/promises');
        const spawnedCwd = await realpathFsp(await readFile(cwdFile, 'utf8'));
        expect(spawnedCwd).toBe(await realpathFsp(repoDir));
      } finally {
        if (originalPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = originalPath;
        if (originalGhRepo === undefined) delete process.env['GH_REPO'];
        else process.env['GH_REPO'] = originalGhRepo;
        if (originalGhBin === undefined) delete process.env['CQ_GH_BIN'];
        else process.env['CQ_GH_BIN'] = originalGhBin;
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
