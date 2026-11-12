// Split from test/ops/merge/executeMerges.test.ts (F3): safeArgs — the I3
// argv guard, safeRunner, and the realMergeEffects argv routing.
import { describe, expect, test } from 'vitest';
import {
  UnsafeMergeArgsError,
  headRefFor,
  mergeWorktreeBranchFor,
  realMergeEffects,
  safeArgs,
  safeRunner,
} from '../../../src/adapters/forge-github/mergeEffects.js';
import { HARDENED_DIFF_FLAGS } from '../../../src/shared/gitHarden.js';
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

  test('round-193 + round-1193-r3: the base-ref read shape passes (tip OID added); broader gh pr view shapes are refused', () => {
    expect(safeArgs(['pr', 'view', '7', '--json', 'baseRefName,baseRefOid'])).toEqual([
      'pr',
      'view',
      '7',
      '--json',
      'baseRefName,baseRefOid',
    ]);
    // A different json field, a field list without the OID, a missing pr
    // number, a trailing flag, and a non-numeric pr are all unknown — the
    // read stays exactly one shape.
    expect(() => safeArgs(['pr', 'view', '7', '--json', 'headRefName'])).toThrow(
      /refused: unknown argv shape/,
    );
    expect(() => safeArgs(['pr', 'view', '7', '--json', 'baseRefName,headRefName'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['pr', 'view', '7', '--json', 'baseRefName'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['pr', 'view', '--json', 'baseRefName,baseRefOid'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() =>
      safeArgs(['pr', 'view', '7', '--json', 'baseRefName,baseRefOid', '--jq', '.']),
    ).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['pr', 'view', 'abc', '--json', 'baseRefName,baseRefOid'])).toThrow(
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

  test('realMergeEffects.readBaseRef reads exactly `gh pr view <n> --json baseRefName,baseRefOid` (injected runner)', async () => {
    const ghCalls: string[][] = [];
    const effects = realMergeEffects({
      repoRoot: '/repo',
      run: async (args: string[]) => {
        ghCalls.push(args);
        return {
          code: 0,
          stdout:
            '{"baseRefName":"main","baseRefOid":"1111222233334444555566667777888899990000"}\n',
          stderr: '',
        };
      },
    });
    const tip = '1111222233334444555566667777888899990000';
    expect(await effects.readBaseRef(7)).toEqual({
      ok: true,
      baseRefName: 'main',
      baseTipSha: tip,
    });
    expect(ghCalls).toEqual([['pr', 'view', '7', '--json', 'baseRefName,baseRefOid']]);

    // An OID that is not full 40-hex is OMITTED (the gate refuses a
    // merge parent it cannot verify), never guessed.
    const shortOid = realMergeEffects({
      repoRoot: '/repo',
      run: async () => ({
        code: 0,
        stdout: '{"baseRefName":"main","baseRefOid":"abc123"}\n',
        stderr: '',
      }),
    });
    expect(await shortOid.readBaseRef(7)).toEqual({ ok: true, baseRefName: 'main' });

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

  test('mergeWorktreeBranchFor is the prepared worktree branch the resolver gates on (#1193)', () => {
    expect(mergeWorktreeBranchFor(7)).toBe('refs/heads/cq-merge/pr-7');
  });
});

describe('safeArgs round-1193: the read-only diff shape (the resolver pre-push scan)', () => {
  const from = sha('a');
  const to = sha('b');
  // The hardened flag list is load-bearing (review P1, PR #1628): the
  // pinned set is the shape, asserted verbatim so the gate cannot drift
  // off it.
  const FLAGS = [...HARDENED_DIFF_FLAGS, '--unified=0'];
  const legal = (): string[] => ['-C', '/repo', 'diff', ...FLAGS, from, to];

  test('the EXACT shape passes — the hardened flags verbatim, then two full 40-hex shas', () => {
    expect(safeArgs(legal())).toEqual(['-C', '/repo', 'diff', ...FLAGS, from, to]);
    // The hardening is present, by name (review P1, PR #1628).
    expect(legal()).toContain('--no-ext-diff');
    expect(legal()).toContain('--no-textconv');
  });

  test('every deviation is an unknown shape — shas must be FULL hex, flags fixed, arity exact', () => {
    const base = ['diff', ...FLAGS] as string[];
    // A short sha or a revision expression can never ride the shape.
    expect(() => safeArgs([...base, 'abc123', to])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs([...base, `${from}..${to}`, to])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs([...base, from, 'refs/heads/feat'])).toThrow(UnsafeMergeArgsError);
    // Flag drift: reordered, dropped, or extra.
    const reordered = ['diff', FLAGS[1] as string, FLAGS[0] as string, ...FLAGS.slice(2), from, to];
    expect(() => safeArgs(reordered)).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['diff', ...FLAGS.slice(1), from, to])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs([...base, '--stat', from, to])).toThrow(UnsafeMergeArgsError);
    // The historical pre-hardening argv (--no-color + --unified=0 only) is
    // refused — the old shape must not keep passing beside the new one.
    expect(() => safeArgs(['diff', '--no-color', '--unified=0', from, to])).toThrow(
      UnsafeMergeArgsError,
    );
    // Arity drift.
    expect(() => safeArgs(['diff', ...FLAGS, from])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['diff'])).toThrow(UnsafeMergeArgsError);
    // A mutation vocabulary is still refused: diff is READ-ONLY by shape,
    // and no flag can turn it otherwise.
    expect(() => safeArgs([...base, '--output=/tmp/x', from, to])).toThrow(UnsafeMergeArgsError);
  });

  test('realMergeEffects.diffPatch routes the exact hardened argv at the repo root (injected runner — zero processes, no fs)', async () => {
    const gitCalls: string[][] = [];
    const effects = realMergeEffects({
      repoRoot: '/repo',
      gitRun: async (args: string[]) => {
        gitCalls.push(args);
        return { code: 0, stdout: 'diff --git a/x b/x\n', stderr: '' };
      },
    });
    const result = await effects.diffPatch(from, to);
    expect(result).toEqual({ code: 0, stdout: 'diff --git a/x b/x\n', stderr: '' });
    expect(gitCalls).toEqual([['-C', '/repo', 'diff', ...FLAGS, from, to]]);
  });
});

describe('safeArgs round-1193-r2: the topology read shape (rev-list --parents)', () => {
  const resolved = sha('c');

  test('the EXACT shape passes — --parents -n 1 plus one full 40-hex sha', () => {
    expect(safeArgs(['-C', '/repo', 'rev-list', '--parents', '-n', '1', resolved])).toEqual([
      '-C',
      '/repo',
      'rev-list',
      '--parents',
      '-n',
      '1',
      resolved,
    ]);
  });

  test('every deviation is an unknown shape', () => {
    expect(() => safeArgs(['rev-list', '--parents', '-n', '1', 'abc123'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['rev-list', '-n', '1', resolved])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['rev-list', '--parents', resolved])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['rev-list', '--parents', '-n', '2', resolved])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['rev-list', '--parents', '-n', '1', resolved, 'HEAD'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['rev-list', '--parents', '-n', '1'])).toThrow(UnsafeMergeArgsError);
  });

  test('realMergeEffects.commitParents routes the exact argv and excludes the queried sha (injected runner)', async () => {
    const gitCalls: string[][] = [];
    const effects = realMergeEffects({
      repoRoot: '/repo',
      gitRun: async (args: string[]) => {
        gitCalls.push(args);
        return { code: 0, stdout: `${resolved} ${sha('a')} ${sha('b')}\n`, stderr: '' };
      },
    });
    const answer = await effects.commitParents(resolved);
    expect(answer).toEqual({ ok: true, parents: [sha('a'), sha('b')] });
    expect(gitCalls).toEqual([['-C', '/repo', 'rev-list', '--parents', '-n', '1', resolved]]);
    const missing = realMergeEffects({
      repoRoot: '/repo',
      gitRun: async () => ({ code: 128, stdout: '', stderr: 'bad object' }),
    });
    expect(await missing.commitParents(resolved)).toEqual({ ok: false });
  });
});

describe('safeArgs round-1193-r3: the ancestry read shape (merge-base --is-ancestor)', () => {
  const parent = sha('a');
  const tip = sha('b');

  test('the EXACT shape passes — --is-ancestor plus two full 40-hex shas', () => {
    expect(safeArgs(['-C', '/repo', 'merge-base', '--is-ancestor', parent, tip])).toEqual([
      '-C',
      '/repo',
      'merge-base',
      '--is-ancestor',
      parent,
      tip,
    ]);
  });

  test('every deviation is an unknown shape', () => {
    expect(() => safeArgs(['merge-base', parent, tip])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['merge-base', '--is-ancestor', 'abc123', tip])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['merge-base', '--is-ancestor', parent, 'refs/heads/main'])).toThrow(
      UnsafeMergeArgsError,
    );
    expect(() => safeArgs(['merge-base', '--is-ancestor', parent])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['merge-base', '--is-ancestor', '--all', parent, tip])).toThrow(
      UnsafeMergeArgsError,
    );
  });

  test('realMergeEffects.isAncestor routes the exact argv (injected runner — zero processes)', async () => {
    const gitCalls: string[][] = [];
    const effects = realMergeEffects({
      repoRoot: '/repo',
      gitRun: async (args: string[]) => {
        gitCalls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const answer = await effects.isAncestor(parent, tip);
    expect(answer).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(gitCalls).toEqual([['-C', '/repo', 'merge-base', '--is-ancestor', parent, tip]]);
    // Exit 1 is a NOT-ancestor ANSWER, not a fault.
    const no = realMergeEffects({
      repoRoot: '/repo',
      gitRun: async () => ({ code: 1, stdout: '', stderr: '' }),
    });
    expect((await no.isAncestor(parent, tip)).code).toBe(1);
  });
});
