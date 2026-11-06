// Split provenance: test/ops/sweep/planSweep.test.ts was split into
// planSweep.{selector,selection,ledger,jobs,legacy-scheme,signature,subprocess}.test.ts
// plus planSweep.helpers.ts (shared fixtures). This file carries the shipped
// subprocess deps binding: NUL-delimited parse, argv shape, git-fault mapping
// and the real-git name-status test.
import { describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SWEEP_DIFF_FLAGS } from '../../../src/shared/gitDiffFlags.js';
import {
  changedFilesArgs,
  makeSubprocessSweepPlannerDeps,
  mapSweepGitFault,
  parseNullDelimitedChangedFiles,
} from '../../../src/ops/sweep/planSweep.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

// ---------------------------------------------------------------------------
// 6. The shipped subprocess deps binding (the registry importer's seam)
// ---------------------------------------------------------------------------

describe('makeSubprocessSweepPlannerDeps (captured fixtures)', () => {
  test('NUL-delimited name-status parse: spaces survive, empty entries from the trailing NUL drop', () => {
    expect(
      parseNullDelimitedChangedFiles('M\0packages/core/src/a.ts\0A\0docs/my file.md\0'),
    ).toEqual([
      { path: 'packages/core/src/a.ts', status: 'M', deleted: false, fixerTarget: true },
      { path: 'docs/my file.md', status: 'A', deleted: false, fixerTarget: true },
    ]);
    expect(parseNullDelimitedChangedFiles('D\0gone.ts\0')).toEqual([
      { path: 'gone.ts', status: 'D', deleted: true, fixerTarget: false },
    ]);
    // A rename record carries the OLD then the NEW path; the old side is
    // DELETED (review-debt #150).
    expect(parseNullDelimitedChangedFiles('R100\0old.ts\0new.ts\0')).toEqual([
      { path: 'old.ts', status: 'R100', deleted: true, fixerTarget: false },
      { path: 'new.ts', status: 'R100', deleted: false, fixerTarget: true },
    ]);
    // A copy's source still EXISTS but is UNCHANGED: selection evidence, not a
    // fixer target (r1 finding 2).
    expect(parseNullDelimitedChangedFiles('C75\0src.ts\0copy.ts\0')).toEqual([
      { path: 'src.ts', status: 'C75', deleted: false, fixerTarget: false },
      { path: 'copy.ts', status: 'C75', deleted: false, fixerTarget: true },
    ]);
    expect(parseNullDelimitedChangedFiles('')).toEqual([]);
  });

  test('the shipped binding exposes both seams; effects bind input-driven at dispatch', () => {
    const deps = makeSubprocessSweepPlannerDeps('/repo');
    expect(typeof deps.changedFiles).toBe('function');
    expect(typeof deps.queryLedger).toBe('function');
  });

  test('the changed-files argv terminates the rev list AFTER the base', () => {
    const args = changedFilesArgs('origin/main');
    expect(args).toEqual(['diff', ...SWEEP_DIFF_FLAGS, '--name-status', '-z', 'origin/main', '--']);
    // The base is a REVISION (before the terminator); the trailing `--`
    // ends the rev list with an empty pathspec — never `-- <base>`, which
    // would read the base as a PATH.
    expect(args.indexOf('origin/main')).toBeLessThan(args.indexOf('--'));
    expect(args[args.length - 1]).toBe('--');
    // A ref spelled exactly like a tracked file can no longer die with
    // "ambiguous argument: both revision and filename" — the terminator
    // disambiguates without reclassifying the base.
  });

  test('mapSweepGitFault names the OUTPUT LIMIT for a maxBuffer overflow (which also sets killed)', () => {
    const error = mapSweepGitFault(
      ['diff'],
      { killed: true, message: 'maxBuffer length exceeded' },
      '',
      600_000,
    );
    expect(error.message).toMatch(/output limit/);
    expect(error.message).toMatch(/maxBuffer/);
    expect(error.message).not.toMatch(/timed out/);
  });

  test('mapSweepGitFault names the TIMEOUT for a non-overflow kill', () => {
    const error = mapSweepGitFault(
      ['diff'],
      { killed: true, message: 'signal: SIGKILL' },
      '',
      600_000,
    );
    expect(error.message).toMatch(/timed out/);
    expect(error.message).not.toMatch(/output limit/);
  });

  test('mapSweepGitFault carries the stderr text for a plain non-zero exit', () => {
    const error = mapSweepGitFault(
      ['status'],
      { code: 128, killed: false, message: 'exited with code 128' },
      'fatal: not a git repository',
      600_000,
    );
    expect(error.message).toMatch(/exit 128/);
    expect(error.message).toMatch(/fatal: not a git repository/);
  });

  test('REAL git: delete + rename parse into ChangedFile entries with the right target flags (r1 finding 4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-name-status-'));
    // The fixture must not read the outer repository or host git config: a
    // hook-inherited GIT_DIR/GIT_WORK_TREE would redirect these commands,
    // and a host commit.gpgsign/hooksPath would fail the commit below.
    const env = {
      ...scrubbedGitEnv(),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (args: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(
          'git',
          [
            '-c',
            'gc.auto=0',
            '-c',
            'maintenance.auto=false',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'core.hooksPath=/dev/null',
            ...args,
          ],
          { cwd: dir, env, timeout: 15_000, killSignal: 'SIGKILL' },
          (error, stdout, stderr) => {
            if (error !== null) reject(new Error(stderr.trim() || error.message));
            else resolve(stdout);
          },
        );
      });
    try {
      await git(['init', '-q', '-b', 'main', '.']);
      await git(['config', 'user.email', 't@example.invalid']);
      await git(['config', 'user.name', 'T']);
      writeFileSync(join(dir, 'keep.ts'), 'a\n');
      writeFileSync(join(dir, 'gone.ts'), 'b\n');
      writeFileSync(join(dir, 'old.ts'), 'c\n');
      await git(['add', '-A']);
      await git(['commit', '-qm', 'base']);
      rmSync(join(dir, 'gone.ts'));
      await git(['mv', 'old.ts', 'new.ts']);
      const changed = await makeSubprocessSweepPlannerDeps(dir).changedFiles('HEAD');
      const byPath = new Map(changed.map((entry) => [entry.path, entry]));
      expect(byPath.get('gone.ts')).toMatchObject({ deleted: true, fixerTarget: false });
      // Rename detection on or off, the source is a non-target and the
      // destination a target.
      expect(byPath.get('old.ts')).toMatchObject({ fixerTarget: false });
      expect(byPath.get('new.ts')).toMatchObject({ deleted: false, fixerTarget: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
