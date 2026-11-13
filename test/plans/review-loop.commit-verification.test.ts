// commitVerificationFailure stage taxonomy (round 2), pinned directly on
// the gate over a minimal fake git (round-1/2 low findings).
import { describe, expect, test } from 'vitest';
import type { GhFn } from '../../src/adapters/forge-github/gh.js';
import { commitVerificationFailure } from '../../src/plans/review-loop.js';
import {
  BEFORE_SHA,
  BEEF_SHA,
  defaultWorld,
  fakeGit,
  NEW_SHA,
  SHA,
} from './review-loop.helpers.js';

// ---------------------------------------------------------------------------
// Verification-failure stages, pinned DIRECTLY on the gate (round-1/2 low):
// `not-40-hex` is unreachable through the loop — parseFixContract already
// rejects non-40-hex claims — so the taxonomy is pinned by calling
// commitVerificationFailure itself over a minimal fake git.
// ---------------------------------------------------------------------------

describe('commitVerificationFailure stage taxonomy (round 2)', () => {
  const gate = async (git: GhFn, sha: string, itemId: string) =>
    commitVerificationFailure(git, '/wt', sha, BEFORE_SHA, itemId);

  test('all six stages are named, in gate order', async () => {
    // notAncestorGit: NEW_SHA resolves and descends but its HEAD-ancestry is
    // refused; attributedGit: NEW_SHA's message names T1.
    const notAncestorGit = fakeGit(
      { ...defaultWorld(), knownShas: [SHA, NEW_SHA], ancestorFails: [NEW_SHA] },
      [],
      '/wt',
    );
    const attributedGit = fakeGit(
      { ...defaultWorld(), commitMessages: { [NEW_SHA]: 'Fix review item T1 in src/a.ts' } },
      [],
      '/wt',
    );
    // not-40-hex — rejected BEFORE any git call (the literal "HEAD" shape).
    expect(await gate(notAncestorGit, 'HEAD', 'T1')).toBe('not-40-hex');
    // not-descendant — the before-head itself is not a fix; an unresolvable
    // sha cannot be a strict descendant either.
    expect(await gate(notAncestorGit, BEFORE_SHA, 'T1')).toBe('not-descendant');
    expect(await gate(notAncestorGit, BEEF_SHA, 'T1')).toBe('not-descendant');
    // not-ancestor — resolvable + descendant, but refused against HEAD.
    expect(await gate(notAncestorGit, NEW_SHA, 'T1')).toBe('not-ancestor');
    // empty-diff — a valid descendant commit with no file changes is rejected.
    const emptyGit = fakeGit(
      { ...defaultWorld(), knownShas: [SHA, NEW_SHA], diffCode: 0 },
      [],
      '/wt',
    );
    expect(await gate(emptyGit, NEW_SHA, 'T1')).toBe('empty-diff');
    const unreadableGit = fakeGit(
      { ...defaultWorld(), knownShas: [SHA, NEW_SHA], diffCode: 2 },
      [],
      '/wt',
    );
    expect(await gate(unreadableGit, NEW_SHA, 'T1')).toBe('diff-unreadable');
    // attribution-missing — the message must name THIS item.
    expect(await gate(attributedGit, NEW_SHA, 'T1')).toBeNull();
    expect(await gate(attributedGit, NEW_SHA, 'T2')).toBe('attribution-missing');
  });

  test('numeric item ids match at NON-DIGIT boundaries (round 3 low)', async () => {
    // A numeric comment id must not be satisfied by a message naming a
    // digit-superstring ('1234') or a digit-prefixed neighbor ('9123') —
    // the boundary classes (^|[^0-9]) … ([^0-9]|$) refuse both.
    const exact = fakeGit(
      {
        ...defaultWorld(),
        knownShas: [SHA, NEW_SHA],
        commitMessages: { [NEW_SHA]: 'fix 123: apple' },
      },
      [],
      '/wt',
    );
    const superstring = fakeGit(
      {
        ...defaultWorld(),
        knownShas: [SHA, NEW_SHA],
        commitMessages: { [NEW_SHA]: 'fix 1234: apple' },
      },
      [],
      '/wt',
    );
    const prefixed = fakeGit(
      {
        ...defaultWorld(),
        knownShas: [SHA, NEW_SHA],
        commitMessages: { [NEW_SHA]: 'fix 9123: apple' },
      },
      [],
      '/wt',
    );
    expect(await gate(exact, NEW_SHA, '123')).toBeNull();
    expect(await gate(superstring, NEW_SHA, '123')).toBe('attribution-missing');
    expect(await gate(prefixed, NEW_SHA, '123')).toBe('attribution-missing');
  });
});
