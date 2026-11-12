// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,push-scan,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// Subject: I11 forge fact (refs/pull/<pr>/head) under the publication gate.
// Fixtures and the full group header: ./resolveConflict.helpers.ts
import { describe, expect, test } from 'vitest';
import {
  headRefFor,
  mergeWorktreeBranchFor,
} from '../../../src/adapters/forge-github/mergeEffects.js';
import { makeResolveConflictOp } from '../../../src/ops/merge/resolveConflict.js';
import {
  ZERO_USAGE,
  completed,
  baseInput,
  FakeMergeEffects,
  FakeDriver,
  factoryOf,
  fakeLoadPrompt,
  scanClean,
} from './resolveConflict.helpers.js';

// ---------------------------------------------------------------------------
// I11 forge fact carried as a test: the pre-dispatch truth and the gate's
// ref topology under the publication gate (issue #1193)
// ---------------------------------------------------------------------------

describe('I11 forge fact: the head branch IS refs/pull/<pr>/head; the resolution is NOT', () => {
  test('the baseline addresses the pull ref; the gate reads the worktree branch; the push names the head branch', async () => {
    // THE PREMISE (I11: forge facts carried as tests — the sibling pin is
    // executeMerges.happy-path.test.ts's exact-sequence assertions): the
    // pr's PRE-dispatch truth lives on refs/pull/<pr>/head, so the
    // baseline capture (fetch + validate) addresses the pull ref
    // exclusively. Issue #1193 changed what happens AFTER the agent
    // reports acted: the gate locates the resolution on the prepared
    // worktree's branch (mergeWorktreeBranchFor — a ref the op derives,
    // never agent output) and publishes to the HEAD BRANCH, which the
    // forge reflects back onto the pull ref asynchronously.
    const effects = new FakeMergeEffects(); // default: resolutionSha ≠ baselineSha
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'committed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    await expect(op(baseInput())).resolves.toEqual({
      status: 'ok',
      value: { pr: 44, decision: 'acted', summary: 'committed', usage: ZERO_USAGE },
    });
    // The PRE-dispatch truth was read through the pull ref, exclusively.
    const baselineFetch = effects.calls.filter((call) => call.startsWith('fetch:'));
    expect(baselineFetch).toEqual([`fetch:${headRefFor(44)}`]);
    expect(effects.calls).toContain(`validate:${headRefFor(44)}`);
    // The gate then read the resolution from the op-derived worktree
    // branch and diffed it against the pull-ref baseline.
    expect(effects.calls).toContain(`validate:${mergeWorktreeBranchFor(44)}`);
    expect(effects.calls).toContain(
      `diff:${String(effects.baselineSha)}..${String(effects.resolutionSha)}`,
    );
    // And the publication named the head branch — with an explicit
    // src:dst refspec (the sha the gate validated), never a bare or
    // symbolic source.
    expect(effects.calls).toContain(
      `push:${String(effects.resolutionSha)}:refs/heads/feat/topic@/wt/pr-44`,
    );
  });
});
