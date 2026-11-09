// Split from test/ops/merge/executeMerges.test.ts (F3): safeArgs — the I3
// argv guard, safeRunner, and the realMergeEffects argv routing.
import { describe, expect, test } from 'vitest';
import {
  UnsafeMergeArgsError,
  headRefFor,
  realMergeEffects,
  safeArgs,
  safeRunner,
} from '../../../src/adapters/forge-github/mergeEffects.js';
import { OK, sha } from './executeMerges.helpers.js';

// ---------------------------------------------------------------------------
// The I3 guard (effects.ts)
// ---------------------------------------------------------------------------

describe('safeArgs — the I3 guard, one test per forbidden shape', () => {
  test('squash: a squash-merge argv throws', () => {
    expect(() => safeArgs(['pr', 'merge', '7', '--squash'])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['pr', 'merge', '7', 'squash'])).toThrow(UnsafeMergeArgsError);
  });

  test("force: '--force' (and --force-with-lease) throws", () => {
    expect(() => safeArgs(['push', 'origin', '--force', 'feat'])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['push', 'origin', '--force-with-lease=feat', 'feat'])).toThrow(
      UnsafeMergeArgsError,
    );
  });

  test('-f throws', () => {
    expect(() => safeArgs(['worktree', 'add', '-f', '/wt/pr-7'])).toThrow(UnsafeMergeArgsError);
  });

  test('rebase: bare and as a merge-method flag throw', () => {
    expect(() => safeArgs(['rebase', 'main'])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['pr', 'merge', '7', '--rebase'])).toThrow(UnsafeMergeArgsError);
  });

  test("'--hard' throws", () => {
    expect(() => safeArgs(['reset', '--hard', 'HEAD~1'])).toThrow(UnsafeMergeArgsError);
  });

  test('push-to-main throws in every spelling', () => {
    expect(() => safeArgs(['push', 'origin', 'main'])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['push', 'origin', 'HEAD:main'])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['push', 'origin', 'feat:refs/heads/main'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['-C', '/repo', 'push', 'origin', ':main'])).toThrow(
      UnsafeMergeArgsError,
    );
  });

  test('round-1: a push with NO explicit refspec is refused (push.default could pick the protected branch)', () => {
    expect(() => safeArgs(['push', 'origin'])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['push'])).toThrow(UnsafeMergeArgsError);
    // An explicit src:dst refspec keeps the push legal.
    expect(safeArgs(['push', 'origin', 'feat:refs/heads/feat'])).toEqual([
      'push',
      'origin',
      'feat:refs/heads/feat',
    ]);
  });

  test('round-1: bundled short flags carrying an f are refused (-qf rides --force)', () => {
    expect(() => safeArgs(['push', '-qf', 'origin', 'feat'])).toThrow(UnsafeMergeArgsError);
    // An f-free bundle in a documented shape stays legal (the exact
    // worktree-add prepare form — allowlist, round 2).
    expect(
      safeArgs(['worktree', 'add', '-B', 'cq-merge/pr-7', '/wt/pr-7', 'refs/pull/7/head']),
    ).toEqual(['worktree', 'add', '-B', 'cq-merge/pr-7', '/wt/pr-7', 'refs/pull/7/head']);
  });

  test("round-1: '--amend' is a forbidden token (history rewrite)", () => {
    expect(() => safeArgs(['commit', '--amend'])).toThrow(UnsafeMergeArgsError);
  });

  test('the executor’s own argv shapes pass untouched', () => {
    expect(safeArgs(['pr', 'merge', '7', '--merge'])).toEqual(['pr', 'merge', '7', '--merge']);
    expect(safeArgs(['pr', 'edit', '7', '--base', 'main'])).toEqual([
      'pr',
      'edit',
      '7',
      '--base',
      'main',
    ]);
    expect(
      safeArgs(['-C', '/repo', 'fetch', 'origin', '+refs/pull/7/head:refs/pull/7/head']),
    ).toEqual(['-C', '/repo', 'fetch', 'origin', '+refs/pull/7/head:refs/pull/7/head']);
    expect(
      safeArgs([
        '-C',
        '/repo',
        'worktree',
        'add',
        '-B',
        'cq-merge/pr-7',
        '/wt/pr-7',
        'refs/pull/7/head',
      ]),
    ).toEqual([
      '-C',
      '/repo',
      'worktree',
      'add',
      '-B',
      'cq-merge/pr-7',
      '/wt/pr-7',
      'refs/pull/7/head',
    ]);
    expect(safeArgs(['-C', '/wt/pr-7', 'push', 'origin', 'HEAD:refs/heads/feat-7'])).toEqual([
      '-C',
      '/wt/pr-7',
      'push',
      'origin',
      'HEAD:refs/heads/feat-7',
    ]);
  });

  test('safeRunner — the enforcement point: unsafe argv never reaches the runner', async () => {
    const seen: string[][] = [];
    const run = safeRunner(async (args: string[]) => {
      seen.push(args);
      return OK;
    });
    expect(() => run(['push', 'origin', 'main'])).toThrow(UnsafeMergeArgsError);
    await expect(run(['pr', 'merge', '7', '--merge'])).resolves.toEqual(OK);
    expect(seen).toEqual([['pr', 'merge', '7', '--merge']]);
  });

  test('CR-5: the protected branch is configurable — "deliver" pushes refused, "main" pushes pass', () => {
    expect(() => safeArgs(['push', 'origin', 'deliver'], { protectedBranch: 'deliver' })).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() =>
      safeArgs(['push', 'origin', 'HEAD:deliver'], { protectedBranch: 'deliver' }),
    ).toThrow(UnsafeMergeArgsError);
    expect(() =>
      safeArgs(['push', 'origin', 'feat:refs/heads/deliver'], { protectedBranch: 'deliver' }),
    ).toThrow(UnsafeMergeArgsError);
    // Under 'deliver' protection, main is an ordinary branch.
    expect(
      safeArgs(['push', 'origin', 'main:refs/heads/main'], { protectedBranch: 'deliver' }),
    ).toEqual(['push', 'origin', 'main:refs/heads/main']);
    expect(
      safeArgs(['push', 'origin', 'feat:refs/heads/main'], { protectedBranch: 'deliver' }),
    ).toEqual(['push', 'origin', 'feat:refs/heads/main']);
  });

  test('CR-5: the default protected branch is still main (existing callers unchanged)', () => {
    expect(() => safeArgs(['push', 'origin', 'main'])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['push', 'origin', 'HEAD:main'])).toThrow(UnsafeMergeArgsError);
    expect(safeArgs(['push', 'origin', 'deliver:refs/heads/deliver'])).toEqual([
      'push',
      'origin',
      'deliver:refs/heads/deliver',
    ]);
  });

  test('CR-5: safeRunner threads the protected branch to the guard', async () => {
    const seen: string[][] = [];
    const run = safeRunner(
      async (args: string[]) => {
        seen.push(args);
        return OK;
      },
      { protectedBranch: 'deliver' },
    );
    expect(() => run(['push', 'origin', 'deliver'])).toThrow(UnsafeMergeArgsError);
    await expect(run(['push', 'origin', 'main:refs/heads/main'])).resolves.toEqual(OK);
    expect(seen).toEqual([['push', 'origin', 'main:refs/heads/main']]); // deliver never reached the runner
  });

  test('CR-5: realMergeEffects threads the protected branch (guard fires before any process)', () => {
    const effects = realMergeEffects({ repoRoot: '/repo', protectedBranch: 'deliver' });
    expect(() => effects.pushRef('deliver:refs/heads/deliver', '/wt/pr-7')).toThrow(
      UnsafeMergeArgsError,
    );
  });

  test('round-2: a force-marked PUSH refspec is refused outright (+main, +refs/heads/main)', () => {
    expect(() => safeArgs(['push', 'origin', '+main'])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['push', 'origin', '+refs/heads/main'])).toThrow(UnsafeMergeArgsError);
    // I3 forbids force outright — even a non-protected destination may not
    // ride the marker through the guard.
    expect(() => safeArgs(['push', 'origin', '+feat:refs/heads/feat'])).toThrow(
      UnsafeMergeArgsError,
    );
  });

  test('round-2: a FETCH refspec forcing the protected branch is refused; the legal fetch stays legal', () => {
    // A forced update OF local main through the fetch side door.
    expect(() => safeArgs(['-C', '/repo', 'fetch', 'origin', '+x:refs/heads/main'])).toThrow(
      UnsafeMergeArgsError,
    );
    // The executor's own fetch keeps its in-place '+' marker (the PR-head
    // refresh — a force-pushed head must still land).
    expect(
      safeArgs(['-C', '/repo', 'fetch', 'origin', '+refs/pull/7/head:refs/pull/7/head']),
    ).toEqual(['-C', '/repo', 'fetch', 'origin', '+refs/pull/7/head:refs/pull/7/head']);
  });

  test('round-2: bare symbolic push refspecs are refused — explicit src:dst required', () => {
    expect(() => safeArgs(['push', 'origin', 'HEAD'])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['push', 'origin', '@'])).toThrow(UnsafeMergeArgsError);
    expect(safeArgs(['push', 'origin', 'feat:refs/heads/feat'])).toEqual([
      'push',
      'origin',
      'feat:refs/heads/feat',
    ]);
  });

  test('round-2 allowlist: undocumented mutation shapes are refused as unknown', () => {
    expect(() => safeArgs(['pull', '-r'])).toThrow(/refused: unknown argv shape/);
    expect(() => safeArgs(['update-ref', 'refs/heads/main', 'abc123'])).toThrow(
      /refused: unknown argv shape/,
    );
    expect(() => safeArgs(['checkout', '-B', 'main', 'abc123'])).toThrow(
      /refused: unknown argv shape/,
    );
    expect(() => safeArgs(['branch', '-D', 'main'])).toThrow(/refused: unknown argv shape/);
    // A gh argv outside the two documented shapes is equally unknown.
    expect(() => safeArgs(['pr', 'merge', '7', '--squash'])).toThrow(/refused: unknown argv shape/);
    expect(() => safeArgs(['pr', 'close', '7'])).toThrow(/refused: unknown argv shape/);
  });

  test('round-2 allowlist: an empty or arity-starved argv is unknown', () => {
    expect(() => safeArgs([])).toThrow(/refused: unknown argv shape/);
    expect(() => safeArgs(['-C'])).toThrow(/refused: unknown argv shape/);
    expect(() => safeArgs(['rev-parse'])).toThrow(/refused: unknown argv shape/);
  });

  test('VB2F batch gate: trailing tokens on an otherwise-legal gh shape are refused — --admin/--squash/--delete-branch cannot ride the merge, --add-label cannot ride the retarget', () => {
    expect(() => safeArgs(['pr', 'merge', '7', '--merge', '--admin'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['pr', 'merge', '7', '--merge', '--squash'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['pr', 'merge', '7', '--merge', '--delete-branch'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['pr', 'edit', '7', '--base', 'main', '--add-label', 'x'])).toThrow(
      UnsafeMergeArgsError,
    );
    // The exact shapes still pass.
    expect(safeArgs(['pr', 'merge', '7', '--merge'])).toEqual(['pr', 'merge', '7', '--merge']);
    // The head-commit pin (#186) is the ONE allowed trailing pair, and only
    // as a full 40-hex sha.
    const pinned = ['pr', 'merge', '7', '--merge', '--match-head-commit', sha('a')];
    expect(safeArgs(pinned)).toEqual(pinned);
    expect(() =>
      safeArgs(['pr', 'merge', '7', '--merge', '--match-head-commit', 'deadbeef']),
    ).toThrow(UnsafeMergeArgsError);
    expect(() =>
      safeArgs(['pr', 'merge', '7', '--merge', '--match-head-commit', `${sha('a')}x`]),
    ).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['pr', 'merge', '7', '--merge', '--match-head-commit'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() =>
      safeArgs(['pr', 'merge', '7', '--merge', '--match-head-commit', sha('a'), '--admin']),
    ).toThrow(UnsafeMergeArgsError);
  });

  test('round-193: the base-ref read shape passes; broader gh pr view shapes are refused', () => {
    expect(safeArgs(['pr', 'view', '7', '--json', 'baseRefName'])).toEqual([
      'pr',
      'view',
      '7',
      '--json',
      'baseRefName',
    ]);
    // A different json field, a multi-field list, a missing pr number, a
    // trailing flag, and a non-numeric pr are all unknown — the read stays
    // exactly one shape.
    expect(() => safeArgs(['pr', 'view', '7', '--json', 'headRefName'])).toThrow(
      /refused: unknown argv shape/,
    );
    expect(() => safeArgs(['pr', 'view', '7', '--json', 'baseRefName,headRefName'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['pr', 'view', '--json', 'baseRefName'])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['pr', 'view', '7', '--json', 'baseRefName', '--jq', '.'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['pr', 'view', 'abc', '--json', 'baseRefName'])).toThrow(
      UnsafeMergeArgsError,
    );
  });

  test('round-3: push FLAGS are refused — the discarded-flag blind spot is closed', () => {
    // Each would otherwise be a legal explicit src:dst push — refused
    // BECAUSE of the force token riding the tail.
    expect(() => safeArgs(['push', 'origin', '--force', 'feat:refs/heads/feat'])).toThrow(
      /flags are not part of the documented push shape/,
    );
    expect(() =>
      safeArgs(['push', 'origin', '--force-with-lease', 'feat:refs/heads/feat']),
    ).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['push', 'origin', '-qf', 'feat:refs/heads/feat'])).toThrow(
      UnsafeMergeArgsError,
    );
    // The flag-free explicit push stays legal.
    expect(safeArgs(['push', 'origin', 'feat:refs/heads/feat'])).toEqual([
      'push',
      'origin',
      'feat:refs/heads/feat',
    ]);
  });

  test('round-3: an empty-src deletion refspec is refused (remote-branch deletion)', () => {
    expect(() => safeArgs(['push', 'origin', ':refs/heads/feat'])).toThrow(UnsafeMergeArgsError);
    expect(safeArgs(['push', 'origin', 'feat:refs/heads/feat'])).toEqual([
      'push',
      'origin',
      'feat:refs/heads/feat',
    ]);
  });

  test('round-4: the fetch shape is FLAG-FREE and GLOB-FREE — the remote slot included', () => {
    // A flag with no ':' is not a refspec, so the destination loop below
    // never saw it: unconditional refusal on sight.
    expect(() => safeArgs(['fetch', 'origin', '--upload-pack=<cmd>'])).toThrow(
      /flags and globs are not part of the documented fetch shape/,
    );
    // The flag lands in the remote slot — still refused.
    expect(() => safeArgs(['fetch', '--upload-pack=<cmd>', 'origin', 'x'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['-C', '/repo', 'fetch', '-q', 'origin', 'main'])).toThrow(
      UnsafeMergeArgsError,
    );
    // A glob names no single destination, so the protected-branch check
    // cannot see the forced update of main it authorizes.
    expect(() => safeArgs(['fetch', 'origin', '+refs/heads/*:refs/heads/*'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['fetch', 'origin', 'refs/heads/main?'])).toThrow(UnsafeMergeArgsError);
    // The executor's own fetch (and the flag-free plain forms) stay legal.
    expect(
      safeArgs(['-C', '/repo', 'fetch', 'origin', '+refs/pull/7/head:refs/pull/7/head']),
    ).toEqual(['-C', '/repo', 'fetch', 'origin', '+refs/pull/7/head:refs/pull/7/head']);
    expect(safeArgs(['fetch', 'origin', 'main'])).toEqual(['fetch', 'origin', 'main']);
  });

  test('round-3: worktree list/remove are flag-free — --force is refused', () => {
    expect(() => safeArgs(['worktree', 'remove', '--force', '/wt/pr-7'])).toThrow(
      /flags are not part of the documented worktree remove shape/,
    );
    expect(() => safeArgs(['worktree', 'list', '--porcelain'])).toThrow(UnsafeMergeArgsError);
    // The documented flag-free shapes stay legal (the real impl's
    // worktreeRemove builds exactly the -C form below; it deliberately
    // omits --force).
    expect(safeArgs(['worktree', 'remove', '/wt/pr-7'])).toEqual([
      'worktree',
      'remove',
      '/wt/pr-7',
    ]);
    expect(safeArgs(['-C', '/repo', 'worktree', 'remove', '/wt/pr-7'])).toEqual([
      '-C',
      '/repo',
      'worktree',
      'remove',
      '/wt/pr-7',
    ]);
  });

  test('realMergeEffects routes the gh argv through the guard (injected runner — zero processes)', async () => {
    const ghCalls: string[][] = [];
    const effects = realMergeEffects({
      repoRoot: '/repo',
      run: async (args: string[]) => {
        ghCalls.push(args);
        return OK;
      },
    });
    expect(await effects.mergePr(7, { method: 'merge' })).toEqual(OK);
    await effects.mergePr(8, { method: 'merge', matchHeadCommit: sha('a') });
    expect(ghCalls).toEqual([
      ['pr', 'merge', '7', '--merge'],
      ['pr', 'merge', '8', '--merge', '--match-head-commit', sha('a')],
    ]);
  });

  test('realMergeEffects.readBaseRef reads exactly `gh pr view <n> --json baseRefName` (injected runner)', async () => {
    const ghCalls: string[][] = [];
    const effects = realMergeEffects({
      repoRoot: '/repo',
      run: async (args: string[]) => {
        ghCalls.push(args);
        return { code: 0, stdout: '{"baseRefName":"main"}\n', stderr: '' };
      },
    });
    expect(await effects.readBaseRef(7)).toEqual({ ok: true, baseRefName: 'main' });
    expect(ghCalls).toEqual([['pr', 'view', '7', '--json', 'baseRefName']]);

    // A nonzero exit, unparseable JSON, and a missing/empty field all fail
    // closed as { ok: false } — never a guessed base.
    const broken = realMergeEffects({
      repoRoot: '/repo',
      run: async () => ({ code: 1, stdout: '', stderr: 'not found' }),
    });
    expect(await broken.readBaseRef(7)).toEqual({ ok: false });

    const garbage = realMergeEffects({
      repoRoot: '/repo',
      run: async () => ({ code: 0, stdout: 'not json', stderr: '' }),
    });
    expect(await garbage.readBaseRef(7)).toEqual({ ok: false });

    const empty = realMergeEffects({
      repoRoot: '/repo',
      run: async () => ({ code: 0, stdout: '{"baseRefName":""}', stderr: '' }),
    });
    expect(await empty.readBaseRef(7)).toEqual({ ok: false });

    const missing = realMergeEffects({
      repoRoot: '/repo',
      run: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    });
    expect(await missing.readBaseRef(7)).toEqual({ ok: false });

    // A whitespace-padded value is TRIMMED (no false stale at the
    // consumer); a whitespace-only value is empty-after-trim → fail closed.
    const padded = realMergeEffects({
      repoRoot: '/repo',
      run: async () => ({ code: 0, stdout: '{"baseRefName":"  main  "}', stderr: '' }),
    });
    expect(await padded.readBaseRef(7)).toEqual({ ok: true, baseRefName: 'main' });

    const blank = realMergeEffects({
      repoRoot: '/repo',
      run: async () => ({ code: 0, stdout: '{"baseRefName":"   "}', stderr: '' }),
    });
    expect(await blank.readBaseRef(7)).toEqual({ ok: false });

    // An invalid pr is refused BEFORE any process: the read validates its
    // own input rather than trusting the caller.
    const noCall: string[][] = [];
    const invalid = realMergeEffects({
      repoRoot: '/repo',
      run: async (args: string[]) => {
        noCall.push(args);
        return { code: 0, stdout: '{"baseRefName":"main"}', stderr: '' };
      },
    });
    expect(await invalid.readBaseRef(0)).toEqual({ ok: false });
    expect(await invalid.readBaseRef(-1)).toEqual({ ok: false });
    expect(await invalid.readBaseRef(1.5)).toEqual({ ok: false });
    expect(noCall).toEqual([]);
  });

  test('realMergeEffects git argv shapes: validate/fetch/push (injected runner — zero processes, no fs)', async () => {
    const gitCalls: string[][] = [];
    const effects = realMergeEffects({
      repoRoot: '/repo',
      gitRun: async (args: string[]) => {
        gitCalls.push(args);
        return { code: 0, stdout: 'abc123def\n', stderr: '' };
      },
    });
    expect(await effects.validateRef('refs/pull/7/head')).toEqual({ ok: true, sha: 'abc123def' });
    await effects.fetchRef('refs/pull/7/head');
    await effects.pushRef('HEAD:refs/heads/feat-7', '/wt/pr-7');
    expect(gitCalls).toEqual([
      ['-C', '/repo', 'rev-parse', '--verify', '--quiet', 'refs/pull/7/head^{commit}'],
      ['-C', '/repo', 'fetch', 'origin', '+refs/pull/7/head:refs/pull/7/head'],
      ['-C', '/wt/pr-7', 'push', 'origin', 'HEAD:refs/heads/feat-7'],
    ]);
    // An unresolvable ref is { ok: false }, never a throw.
    const missing = realMergeEffects({
      repoRoot: '/repo',
      gitRun: async () => ({ code: 1, stdout: '', stderr: 'unknown revision' }),
    });
    expect(await missing.validateRef('refs/pull/7/head')).toEqual({ ok: false });
  });

  test('headRefFor is the PR-number truth ref', () => {
    expect(headRefFor(7)).toBe('refs/pull/7/head');
  });
});
