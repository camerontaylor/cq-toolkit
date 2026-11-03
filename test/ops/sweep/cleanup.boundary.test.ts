// Split provenance: test/ops/sweep/cleanup.test.ts was split by subject into
// the cleanup.*.test.ts siblings in this directory; this file holds the
// boundary contract (pinned contract item 7) and the subprocess seam shape
// pin.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeCleanup, makeSubprocessCleanupEffects } from '../../../src/adapters/git/cleanup.js';
import type { CleanupInput } from '../../../src/adapters/git/cleanup.js';
import {
  INPUT,
  effectsOf,
  failedAt,
  fakeRepo,
  okReport,
  seedAgedClean,
} from './cleanup.helpers.js';

// ---------------------------------------------------------------------------
// 6. The boundary contract
// ---------------------------------------------------------------------------

describe('sweep.cleanup boundary', () => {
  test('REQUIRED: a null or primitive input is a failed result — the boundary guards the top level before any field read', async () => {
    const op = makeCleanup(effectsOf(fakeRepo()));
    const nullError = await failedAt(op, null as unknown as CleanupInput);
    expect(nullError).toMatch(/input must be an object/);
    const numberError = await failedAt(op, 42 as unknown as CleanupInput);
    expect(numberError).toMatch(/input must be an object/);
    const undefinedError = await failedAt(op, undefined as unknown as CleanupInput);
    expect(undefinedError).toMatch(/input must be an object/);
  });

  test('blank fields are refused', async () => {
    const effects = effectsOf(fakeRepo());
    await expect(failedAt(makeCleanup(effects), { ...INPUT, repoRoot: '' })).resolves.toMatch(
      /repoRoot/,
    );
    await expect(failedAt(makeCleanup(effects), { ...INPUT, worktreesDir: '' })).resolves.toMatch(
      /worktreesDir/,
    );
    await expect(failedAt(makeCleanup(effects), { ...INPUT, runPrefix: '' })).resolves.toMatch(
      /runPrefix/,
    );
  });

  test('a dash-leading worktreesDir is refused — the removal path is a positional git argument', async () => {
    const error = await failedAt(makeCleanup(effectsOf(fakeRepo())), {
      ...INPUT,
      worktreesDir: '--upstream=x',
    });
    expect(error).toMatch(/worktreesDir/);
    expect(error).toMatch(/never a flag/);
  });

  test('a control character in repoRoot or worktreesDir is refused — the porcelain lists are line-oriented', async () => {
    const effects = effectsOf(fakeRepo());
    await expect(
      failedAt(makeCleanup(effects), { ...INPUT, repoRoot: '/re\npo' }),
    ).resolves.toMatch(/repoRoot .*control characters|control characters/);
    await expect(
      failedAt(makeCleanup(effects), { ...INPUT, worktreesDir: '/runs/wt\r' }),
    ).resolves.toMatch(/control characters/);
  });

  test('a hostile runPrefix is refused — it guards the only removable branch namespace', async () => {
    const effects = effectsOf(fakeRepo());
    await expect(
      failedAt(makeCleanup(effects), { ...INPUT, runPrefix: '../evil' }),
    ).resolves.toMatch(/runPrefix/);
    await expect(failedAt(makeCleanup(effects), { ...INPUT, runPrefix: 'a..b' })).resolves.toMatch(
      /refname|safe segments/,
    );
    await expect(
      failedAt(makeCleanup(effects), { ...INPUT, runPrefix: 'cq/foo.lock' }),
    ).resolves.toMatch(/runPrefix/);
    await expect(failedAt(makeCleanup(effects), { ...INPUT, runPrefix: '-cq' })).resolves.toMatch(
      /runPrefix/,
    );
  });

  test('olderThanMs must be a non-negative integer; dryRun and force must be booleans', async () => {
    const effects = effectsOf(fakeRepo());
    await expect(failedAt(makeCleanup(effects), { ...INPUT, olderThanMs: -1 })).resolves.toMatch(
      /olderThanMs/,
    );
    await expect(failedAt(makeCleanup(effects), { ...INPUT, olderThanMs: 1.5 })).resolves.toMatch(
      /olderThanMs/,
    );
    await expect(
      failedAt(makeCleanup(effects), { ...INPUT, dryRun: 'yes' } as unknown as CleanupInput),
    ).resolves.toMatch(/dryRun must be a boolean/);
    await expect(
      failedAt(makeCleanup(effects), { ...INPUT, force: 1 } as unknown as CleanupInput),
    ).resolves.toMatch(/force must be a boolean/);
  });

  test('the mutex config boundary: a null mutex and a below-floor staleMs are failed results', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    await expect(
      failedAt(makeCleanup(effectsOf(repo)), {
        ...INPUT,
        mutex: null,
      } as unknown as CleanupInput),
    ).resolves.toMatch(/mutex must be an object/);
    await expect(
      failedAt(makeCleanup(effectsOf(repo)), {
        ...INPUT,
        mutex: { lockPath: '/repo/.cq/git-mutex.lock', staleMs: 100 },
      }),
    ).resolves.toMatch(/mutex\.staleMs \(100\)/);
    expect(repo.removes).toHaveLength(0);
  });

  test('a well-formed mutex config passes the boundary and a dry run still reports', async () => {
    // The well-formed config reaches the REAL makeGitMutex — whose acquire
    // mkdir -p's the lock's parent — so the lockPath needs a real tmpdir.
    const dir = mkdtempSync(join(tmpdir(), 'cleanup-mutex-ok-'));
    try {
      const repo = fakeRepo();
      seedAgedClean(repo);
      const report = await okReport(makeCleanup(effectsOf(repo)), {
        ...INPUT,
        mutex: { lockPath: join(dir, 'git-mutex.lock'), staleMs: 30_000 },
      });
      expect(report.dryRun).toBe(true);
      expect(repo.removes).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the real subprocess binding exposes every seam member (shape pin)', () => {
    const effects = makeSubprocessCleanupEffects('/repo');
    expect(Object.keys(effects).sort()).toEqual([
      'branchDelete',
      'branchTimeMs',
      'isStrictClean',
      'listBranches',
      'listWorktrees',
      'modifiedTimeMs',
      'worktreePrune',
      'worktreeRemove',
    ]);
  });
});
