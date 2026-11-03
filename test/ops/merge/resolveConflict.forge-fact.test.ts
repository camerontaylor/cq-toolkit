// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,acted-verification,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// Subject: I11 forge fact (refs/pull/<pr>/head).
// Fixtures and the full group header: ./resolveConflict.helpers.ts
import { describe, expect, test } from 'vitest';
import { headRefFor } from '../../../src/adapters/forge-github/mergeEffects.js';
import { makeResolveConflictOp } from '../../../src/ops/merge/resolveConflict.js';
import {
  ZERO_USAGE,
  completed,
  baseInput,
  FakeMergeEffects,
  FakeDriver,
  factoryOf,
  fakeLoadPrompt,
} from './resolveConflict.helpers.js';

// ---------------------------------------------------------------------------
// I11 forge fact carried as a test: the head push lands in refs/pull/<pr>/head
// ---------------------------------------------------------------------------

describe('I11 forge fact: a push to the head branch IS refs/pull/<pr>/head', () => {
  test('the acted verification observes the push THROUGH the pull ref, exclusively', async () => {
    // THE PREMISE (I11: forge facts carried as tests — the sibling pin is
    // executeMerges.happy-path.test.ts's exact-sequence assertions, where
    // every baseline and revalidation call addresses refs/pull/<n>/head): the
    // agent pushes to the pr's head BRANCH, and the forge reflects that on
    // the read-only pull ref. The fake models exactly that — its movable
    // head lives ON refs/pull/<pr>/head — so the acted verification's
    // moved-sha reading is the pull ref's new sha.
    const effects = new FakeMergeEffects(); // default: postSha ≠ baselineSha
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
    });

    await expect(op(baseInput())).resolves.toEqual({
      status: 'ok',
      value: { pr: 44, decision: 'acted', summary: 'pushed', usage: ZERO_USAGE },
    });
    // The verification addressed the pr ONLY through the pull ref: every
    // fetch/validate in the log names refs/pull/44/head — the push and its
    // observation are the same ref (the fact the acted check depends on).
    const refCalls = effects.calls.filter(
      (call) => call.startsWith('fetch:') || call.startsWith('validate:'),
    );
    expect(refCalls.every((call) => call.endsWith(headRefFor(44)))).toBe(true);
    expect(refCalls).toContain(`validate:${headRefFor(44)}`);
  });
});
