// F3 — tests for the merge executor
// (src/ops/merge/executeMerges.ts + effects.ts + diagnoseMergeFailure.ts,
// ws-f scope items 3 and 5).
//
// Pinned here, rule by rule (every semantic the module docs state has a
// test):
//   1. THE SEAM (UC §3 row 43, load-bearing): the whole flow runs through a
//      FakeMergeEffects implementing MergeEffects — ZERO real git/gh
//      processes, networks, or filesystems. The exact effect-call sequence
//      is pinned, so ordering, pairing, and seriality are all asserted.
//   2. THE PLAN IS THE ONLY SOURCE OF ACTIONS: order entries execute;
//      needsHuman entries are NEVER executed (no effect call mentions
//      them).
//   3. LIVE-STATE REVALIDATION (a): the baseline sweep FETCHES then reads
//      each planned head (a fresh clone's missing ref is cured by the
//      fetch — CR-4), then each action fetches + revalidates; a head that
//      moved between plan and run → `stale`, never merged.
//   4. A STALE ANCESTOR BLOCKS DESCENDANTS (c): withheld lineages cascade
//      as `blocked_by_ancestor` with no effect calls on the descendants.
//   5. MERGE COMMITS ONLY (b, I3): the negative tests prove safeArgs
//      throws per forbidden shape (squash / --force / -f / rebase /
//      --hard / push-to-main in every spelling); the positive test proves
//      the executor's own argv shapes pass; safeRunner proves the guard
//      sits AHEAD of the runner; realMergeEffects (with injected runners —
//      still zero processes) proves the production argv routing.
//   6. PER-BASE SERIAL ORDER (d): actions record in plan order, each
//      prepare→act→remove strictly serial.
//   7. BOUNDED RETRY (e): /base branch was modified/i failures retry with
//      revalidation between attempts; the cap is maxRetries (+1 total
//      attempts); any other failure is never retried.
//   8. WORKTREES DECOUPLED FROM THE MERGE (f, round 1): merge entries
//      prepare and remove NOTHING (gh pr merge is server-side); the
//      prepare → fn → remove-in-finally lifecycle is tested once against
//      withPreparedWorktree (F4's seam helper) — remove runs even when fn
//      throws, and a removal failure is appended to the original error,
//      never masking it.
//   9. RETARGET-SELF (CR1): executed as the FORGE BASE EDIT (retargetBase
//      onto the plan's baseBranch) — never a merge, never a worktree, and
//      never a ref push (the read-only refs/pull/<n>/head is unpushable —
//      the old push-based shape is pinned as a regression); lands in
//      `retargeted`.
//  10. DIAGNOSE (UC §3 row 45): each bucket maps to its cause
//      (state_drift / merge_rejected / blocked_by_ancestor), the
//      needs-human list is the pr-sorted union, the summary line carries
//      every count, and the function is pure.
//  11. TOTALITY AT THE BASELINE (CR1): an effects throw during the sweep
//      fails the run wholesale — a total report with every pr failed, no
//      escaped exception.
//  12. FETCHED BASELINES (CR-4): only a baseline miss that SURVIVES the
//      fetch is stale (genuine absence); a miss the fetch cures proceeds
//      to merge; a fetch throw fails the run wholesale.
//  13. CONFIGURABLE PROTECTED BRANCH (CR-5): safeArgs rejects pushes to
//      the configured branch (default 'main') under both spellings, and
//      pushes to other branches pass — threaded through safeRunner and
//      realMergeEffects.
//  14. FETCHED RETRY REVALIDATION (round 1): between attempts the check
//      FETCHES before validating — a remote head that moved mid-retry →
//      stale, never a blind second attempt; a nonzero revalidation fetch →
//      failed.
//  15. GUARD HARDENING (round 1): a push with NO explicit refspec is
//      refused (push.default could pick the protected branch); bundled
//      short flags carrying an 'f' (-qf) are force; '--amend' is a
//      forbidden token (history rewrite).
//  16. ALLOWLIST GUARD (round 2): only the eight documented argv shapes
//      execute — everything else is `refused: unknown argv shape`; push
//      refspecs must be explicit src:dst and never '+'-marked; fetch
//      refspecs may carry '+' but never a protected-branch destination.
//  17. GIT-COMMON-DIR WORKTREE ROOT (round 2): prepare derives the root
//      from `rev-parse --git-common-dir` (a linked worktree's .git is a
//      FILE), falling back to <repoRoot>/.git.
//  18. REJECTING EFFECTS + TRANSITIVE CASCADE (round 2): mergePr or
//      retargetBase rejecting → failed (report stays total); a failed
//      ancestor cascades transitively (grandchildren blocked, never
//      executed); a RETARGETED ancestor does not withhold its merge
//      descendant.
//  19. POST-CAP GUARD TIGHTENING (round 3): push tails carry NO flags
//      (the discarded-flag blind spot is closed), push refspecs need both
//      halves non-empty (`:dst` is a remote-branch deletion), and
//      worktree list/remove are flag-free — `--force` is refused.
//
// Split note: the F3 fixture section moved to ./executeMerges.helpers.ts and
// sibling executeMerges.*.test.ts files carry rules 2-19; describes moved
// byte-for-byte.
import { describe, expect, test } from 'vitest';
import { executeMerges } from '../../../src/ops/merge/executeMerges.js';
import { entry, FakeMergeEffects, handPlan, rootChildPlan, sha } from './executeMerges.helpers.js';

// ---------------------------------------------------------------------------
// The executor through the seam
// ---------------------------------------------------------------------------

describe('executeMerges — happy path through a FakeMergeEffects (UC row 43: zero real git/gh)', () => {
  test('a 2-PR stack merges in dependency order, worktrees paired, report exact', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.heads.set(8, sha('b'));
    fake.baseRefs.set(8, 'feat-7'); // the child's plan-time base is its parent's head
    const plan = rootChildPlan(7, 8, 'feat-7');

    const report = await executeMerges({ plan, effects: fake });

    expect(report).toEqual({ merged: [7, 8], retargeted: [], stale: [], failed: [], blocked: [] });
    // The EXACT sequence: baseline sweep first (one fetch + one validate
    // per planned head — fetch BEFORE validate, CR-4), then per action
    // fetch → revalidate → base re-read → server-side merge, parents
    // strictly before children. NO worktree calls anywhere (round 1, rule f).
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head', // baseline sweep — fetch first
      'fetch:refs/pull/8/head',
      'validate:refs/pull/7/head', // then validate
      'validate:refs/pull/8/head',
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head', // live-state revalidation
      'readBase:7', // forge base re-read (#193)
      'merge:7:merge', // server-side; method 'merge' only (I3)
      'fetch:refs/pull/8/head',
      'validate:refs/pull/8/head',
      'readBase:8', // the child's base is its parent's head, unchanged
      'merge:8:merge',
    ]);
  });

  test('an empty plan executes nothing and reports nothing', async () => {
    const fake = new FakeMergeEffects();
    const report = await executeMerges({ plan: handPlan([]), effects: fake });
    expect(report).toEqual({ merged: [], retargeted: [], stale: [], failed: [], blocked: [] });
    expect(fake.calls).toEqual([]);
  });

  test('a planned entry carrying the observed head SHA pins the merge with --match-head-commit (#186)', async () => {
    const fake = new FakeMergeEffects();
    const head = sha('a');
    fake.heads.set(7, head);
    const plan = handPlan([{ pr: 7, action: 'merge', basePr: null, depth: 0, headSha: head }]);
    const report = await executeMerges({ plan, effects: fake });
    expect(report.merged).toEqual([7]);
    expect(fake.mergeMatches).toEqual([{ pr: 7, matchHeadCommit: head }]);
  });

  test("a planned entry with NO observed head SHA still pins to the executor's own baseline observation (#186)", async () => {
    const fake = new FakeMergeEffects();
    const head = sha('a');
    fake.heads.set(7, head);
    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });
    expect(report.merged).toEqual([7]);
    // The executor's baseline revalidation observed `head`, so that is the
    // sha the server-side merge pins — the race is closed even for callers
    // that did not thread a plan head.
    expect(fake.mergeMatches).toEqual([{ pr: 7, matchHeadCommit: head }]);
  });

  test('a MALFORMED plan headSha falls back to the executor baseline — no false stale (#186 review r1)', async () => {
    const fake = new FakeMergeEffects();
    const head = sha('a');
    fake.heads.set(7, head);
    const plan = handPlan([
      { pr: 7, action: 'merge', basePr: null, depth: 0, headSha: 'not-a-sha' },
    ]);
    const report = await executeMerges({ plan, effects: fake });
    expect(report.merged).toEqual([7]);
    expect(report.stale).toEqual([]);
    expect(fake.mergeMatches).toEqual([{ pr: 7, matchHeadCommit: head }]);
  });

  test('a retarget-self entry ignores the plan head SHA — a head move never blocks a needed retarget (#186 review r1)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('b'));
    const plan = handPlan([
      { pr: 7, action: 'retarget-self', basePr: null, depth: 0, headSha: sha('a') },
    ]);
    const report = await executeMerges({ plan, effects: fake });
    expect(report.retargeted).toEqual([7]);
    expect(report.stale).toEqual([]);
  });
});
