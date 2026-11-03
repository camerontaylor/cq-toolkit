// Split provenance: test/ops/sweep/worktreeFor.test.ts was split by subject;
// this file keeps the porcelain / for-each-ref / ls-remote parsers against
// captured fixtures (THE SUBPROCESS ADAPTER's pure surface). The one real-git
// smoke lives in ./worktreeFor.real-git.test.ts.
import { describe, expect, test } from 'vitest';
import {
  parseBranchRefs,
  parseRemoteHeads,
  parseWorktreePorcelain,
} from '../../../src/adapters/git/worktreeFor.js';

// ---------------------------------------------------------------------------
// 7. The subprocess adapter: parsers (fixtures) + one real-git smoke
// ---------------------------------------------------------------------------

describe('subprocess worktree-effects parsers (captured fixtures)', () => {
  test('porcelain: branch entries carry the short branch; bare/detached carry none', () => {
    const text = [
      'worktree /repo',
      'HEAD 1111111111111111111111111111111111111111',
      '',
      'worktree /runs/wt/fix/core',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/cq/09-16a/fix/core',
      '',
      'worktree /runs/wt/fix/cli',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreePorcelain(text)).toEqual([
      { path: '/repo' },
      { path: '/runs/wt/fix/core', branch: 'cq/09-16a/fix/core' },
      { path: '/runs/wt/fix/cli' },
    ]);
  });

  test('for-each-ref: one short branch per non-empty line', () => {
    expect(parseBranchRefs('main\nfeature/x\n\ncq/y/fix/z\n')).toEqual([
      'main',
      'feature/x',
      'cq/y/fix/z',
    ]);
    expect(parseBranchRefs('')).toEqual([]);
  });

  test('ls-remote: sha-tab-ref rows reduce to short branch names', () => {
    expect(
      parseRemoteHeads('1111\trefs/heads/main\n2222\trefs/heads/cq/x\n3333\trefs/tags/v1\n'),
    ).toEqual(['main', 'cq/x']);
    expect(parseRemoteHeads('')).toEqual([]);
  });
});
