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
//  16. ALLOWLIST GUARD (round 2): only the seven documented argv shapes
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
import { chmodSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { match } from '../../helpers/matchers.js';
import { DEFAULT_MAX_RETRIES, executeMerges } from '../../../src/ops/merge/executeMerges.js';
import type { ExecutionReport } from '../../../src/ops/merge/executeMerges.js';
import { diagnoseMergeFailure } from '../../../src/ops/merge/diagnoseMergeFailure.js';
import {
  UnsafeMergeArgsError,
  headRefFor,
  realMergeEffects,
  safeArgs,
  safeRunner,
  withPreparedWorktree,
} from '../../../src/ops/merge/effects.js';
import type { MergeEffects } from '../../../src/ops/merge/effects.js';
import { planMergeOrder } from '../../../src/ops/merge/planMergeOrder.js';
import type {
  PlanBlockReason,
  PlanMergeResult,
  PlannedMergeEntry,
  PlannedPr,
} from '../../../src/ops/merge/planMergeOrder.js';
import type { PrClassification } from '../../../src/ops/merge/classifyPrs.js';
import type { GhResult } from '../../../src/ops/review/gh.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OK: GhResult = { code: 0, stdout: '', stderr: '' };

/** F1's happy verdict (the classification an ordinary eligible PR carries). */
const ELIGIBLE: PrClassification = {
  verdict: 'eligible',
  reason: 'settle_window_elapsed',
  unresolvedExternalThreads: 0,
};

/** An open, classified, untruncated PR — every planning gate open. */
const planned = (pr: number, baseRefName: string, headRefName: string): PlannedPr => ({
  pr,
  headRefName,
  baseRefName,
  state: 'open',
  authorLogin: null,
  classification: ELIGIBLE,
  truncated: false,
});

/** A real F2 plan (provenance: plan → execute, end to end). */
const stackPlan = (prs: PlannedPr[], baseBranch = 'main'): PlanMergeResult =>
  planMergeOrder({ baseBranch, prs });

/** A hand-built plan entry (for shapes the planner's fixtures don't cover,
 * e.g. retarget-self and needsHuman rows). */
const entry = (
  pr: number,
  action: 'merge' | 'retarget-self' = 'merge',
  basePr: number | null = null,
  depth = 0,
): PlannedMergeEntry => ({ pr, action, basePr, depth });

const handPlan = (
  order: PlannedMergeEntry[],
  needsHuman: Array<{ pr: number; reason: PlanBlockReason }> = [],
  baseBranch = 'main',
): PlanMergeResult => ({ order, needsHuman, baseBranch });

const sha = (seed: string): string => seed.repeat(40);

const PR_REF = /^refs\/pull\/(\d+)\/head$/;
const prOfRef = (ref: string): number | null => {
  const match = PR_REF.exec(ref);
  const num = match?.[1];
  return num === undefined ? null : Number.parseInt(num, 10);
};

/**
 * THE FAKE — the entire test surface for executeMerges (UC row 43): an
 * in-memory MergeEffects with zero real processes. It records every effect
 * call so the tests can pin exact sequences, and its maps/setters script
 * the scenarios (heads, queued merge results, drift, failures).
 */
class FakeMergeEffects implements MergeEffects {
  /** Every effect call, in order: `validate:<ref>`, `fetch:<ref>`,
   * `prepare:<pr>@<ref>`, `merge:<pr>:<method>`,
   * `retarget:<pr>:base=<newBase>`, `push:<ref>@<path>`, `remove:<path>`. */
  readonly calls: string[] = [];
  /** pr → live head sha (what validateRef answers). */
  readonly heads = new Map<number, string>();
  /** pr → queued mergePr results, shifted per call; default success. */
  readonly mergeQueue = new Map<number, GhResult[]>();
  /** Every mergePr call's head-commit pin (review-debt #186), in order. */
  readonly mergeMatches: Array<{ pr: number; matchHeadCommit?: string }> = [];
  /** pr → fetchRef fails. */
  readonly fetchFailures = new Set<number>();
  /** pr → pushRef fails (the hostile-forge hook for the CR1 regression). */
  readonly pushFailures = new Set<number>();
  /** pr → retargetBase fails. */
  readonly retargetFailures = new Set<number>();
  /** path → worktreeRemove throws. */
  readonly removeFailures = new Set<string>();
  /** validateRef call count per pr — the drift scripting hook. */
  readonly validateCalls = new Map<number, number>();
  /** When set, every validateRef call for a pr AT/AFTER this per-pr call
   * index (0-based) answers driftSha instead of the live sha — the
   * plan→run drift. Default 1: every validation after the first. */
  driftSha: string | null = null;
  driftFromCall = 1;
  /** When set, validateRef THROWS with this error — the CR1 wholesale
   * baseline-failure scripting hook. */
  validateThrows: Error | null = null;
  /** pr → head known remotely but NOT locally until fetchRef is called for
   * it (the fresh-clone scripting hook, CR-4). */
  readonly headsBehindFetch = new Set<number>();
  /** The refs fetchRef has been called for — what made a head local. */
  readonly fetchedRefs = new Set<string>();
  /** When set, fetchRef THROWS with this error — the CR-4 wholesale
   * baseline-failure scripting hook. */
  fetchThrows: Error | null = null;
  /** pr → queued shas the REMOTE reveals per fetchRef (shifted per call);
   * exhausted/absent → the current head stands. The round-1 hook: the
   * between-attempt fetch is what reveals a remote move. */
  readonly remoteQueue = new Map<number, string[]>();
  /** pr → fail fetchRef from this 0-based call index onward (the round-1
   * between-attempt-fetch-failure scripting hook). */
  readonly fetchFailFromCall = new Map<number, number>();
  readonly fetchCallCounts = new Map<number, number>();
  /** When set, mergePr THROWS with this error (the rejecting-effect hook,
   * round 2). */
  mergeThrows: Error | null = null;
  /** When set, retargetBase THROWS with this error (round 2). */
  retargetThrows: Error | null = null;
  /** When set, worktreePrepare THROWS with this error (the
   * withPreparedWorktree prepare-throw path, round 1). */
  prepareThrows: Error | null = null;

  async validateRef(ref: string): Promise<{ ok: boolean; sha?: string }> {
    this.calls.push(`validate:${ref}`);
    if (this.validateThrows !== null) throw this.validateThrows;
    const pr = prOfRef(ref);
    if (pr === null) return { ok: false };
    const seen = this.validateCalls.get(pr) ?? 0;
    this.validateCalls.set(pr, seen + 1);
    const live = this.heads.get(pr);
    if (live === undefined) return { ok: false };
    // A fresh-clone head does not exist locally until its fetch happened.
    if (this.headsBehindFetch.has(pr) && !this.fetchedRefs.has(ref)) return { ok: false };
    if (this.driftSha !== null && seen >= this.driftFromCall)
      return { ok: true, sha: this.driftSha };
    return { ok: true, sha: live };
  }

  async fetchRef(ref: string): Promise<GhResult> {
    this.calls.push(`fetch:${ref}`);
    this.fetchedRefs.add(ref);
    if (this.fetchThrows !== null) throw this.fetchThrows;
    const pr = prOfRef(ref);
    if (pr !== null) {
      const count = (this.fetchCallCounts.get(pr) ?? 0) + 1;
      this.fetchCallCounts.set(pr, count);
      const failFrom = this.fetchFailFromCall.get(pr);
      if (this.fetchFailures.has(pr) || (failFrom !== undefined && count - 1 >= failFrom)) {
        return { code: 1, stdout: '', stderr: 'fatal: could not read from remote repository' };
      }
      // A successful fetch delivers the remote's next queued sha.
      const next = this.remoteQueue.get(pr)?.shift();
      if (next !== undefined) this.heads.set(pr, next);
    }
    return OK;
  }

  async worktreePrepare(pr: number, ref: string): Promise<{ path: string }> {
    this.calls.push(`prepare:${String(pr)}@${ref}`);
    if (this.prepareThrows !== null) throw this.prepareThrows;
    return { path: `/wt/pr-${String(pr)}` };
  }

  async worktreeRemove(path: string): Promise<void> {
    this.calls.push(`remove:${path}`);
    if (this.removeFailures.has(path)) {
      throw new Error(`worktree remove ${path} refused (tree is dirty)`);
    }
  }

  async mergePr(
    pr: number,
    opts: { method: 'merge'; matchHeadCommit?: string },
  ): Promise<GhResult> {
    this.calls.push(`merge:${String(pr)}:${opts.method}`);
    this.mergeMatches.push({
      pr,
      ...(opts.matchHeadCommit !== undefined ? { matchHeadCommit: opts.matchHeadCommit } : {}),
    });
    if (this.mergeThrows !== null) throw this.mergeThrows;
    const next = this.mergeQueue.get(pr)?.shift();
    return next ?? OK;
  }

  async retargetBase(pr: number, newBase: string): Promise<GhResult> {
    this.calls.push(`retarget:${String(pr)}:base=${newBase}`);
    if (this.retargetThrows !== null) throw this.retargetThrows;
    if (this.retargetFailures.has(pr)) {
      return { code: 1, stdout: '', stderr: '! [remote] base branch not editable' };
    }
    return OK;
  }

  async pushRef(ref: string, fromPath: string): Promise<GhResult> {
    this.calls.push(`push:${ref}@${fromPath}`);
    const pr = prOfRef(ref);
    if (pr !== null && this.pushFailures.has(pr)) {
      return { code: 1, stdout: '', stderr: '! [remote rejected] (protection)' };
    }
    return OK;
  }
}

const mergeCalls = (fake: FakeMergeEffects): string[] =>
  fake.calls.filter((call) => call.startsWith('merge:'));

// ---------------------------------------------------------------------------
// The executor through the seam
// ---------------------------------------------------------------------------

describe('executeMerges — happy path through a FakeMergeEffects (UC row 43: zero real git/gh)', () => {
  test('a 2-PR stack merges in dependency order, worktrees paired, report exact', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.heads.set(8, sha('b'));
    const plan = stackPlan([planned(7, 'main', 'feat-7'), planned(8, 'feat-7', 'feat-8')]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report).toEqual({ merged: [7, 8], retargeted: [], stale: [], failed: [], blocked: [] });
    // The EXACT sequence: baseline sweep first (one fetch + one validate
    // per planned head — fetch BEFORE validate, CR-4), then per action
    // fetch → revalidate → server-side merge, parents strictly before
    // children. NO worktree calls anywhere (round 1, rule f).
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head', // baseline sweep — fetch first
      'fetch:refs/pull/8/head',
      'validate:refs/pull/7/head', // then validate
      'validate:refs/pull/8/head',
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head', // live-state revalidation
      'merge:7:merge', // server-side; method 'merge' only (I3)
      'fetch:refs/pull/8/head',
      'validate:refs/pull/8/head',
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
});

describe('executeMerges — (a) live-state revalidation: drift is skipped, never merged', () => {
  test('a head that moved between plan and run → stale, no worktree, no merge', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.driftSha = sha('b'); // every validation after the baseline sees the moved head
    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.stale).toEqual([
      { pr: 7, detail: match.stringContaining('moved between plan and run') },
    ]);
    expect(report.failed).toEqual([]);
    // The exact calls prove it: baseline fetch → baseline (sha a) → action
    // fetch → revalidate (sha b ≠ a) → skipped. No prepare, no merge, no
    // remove.
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
    ]);
  });

  test('a miss the baseline fetch CURES is not stale — the pr proceeds to merge (CR-4)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.headsBehindFetch.add(7); // fresh clone: nothing local until fetched

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([7]);
    expect(report.stale).toEqual([]);
    // The sweep fetched BEFORE validating, so the baseline saw the cured
    // sha and the action ran normally (server-side merge — no worktree).
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'merge:7:merge',
    ]);
  });

  test('a head unresolvable even AFTER its baseline fetch → stale before any action', async () => {
    const fake = new FakeMergeEffects(); // heads map empty: the ref is gone upstream too
    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });
    expect(report.stale).toEqual([
      { pr: 7, detail: 'head ref unresolvable when execution started' },
    ]);
    // The fetch was attempted first; the miss that survived it is genuine.
    expect(fake.calls).toEqual(['fetch:refs/pull/7/head', 'validate:refs/pull/7/head']);
  });

  test('a fetch throw at the baseline fails the run wholesale — total report, nothing executed', async () => {
    const fake = new FakeMergeEffects();
    fake.fetchThrows = new Error('network down');
    const plan = handPlan([entry(7), entry(8)]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report).toEqual({
      merged: [],
      retargeted: [],
      stale: [],
      failed: [
        {
          pr: 7,
          error: match.stringContaining(
            'baseline sweep aborted during fetchRef (first failure at pr 7): network down',
          ),
        },
        {
          pr: 8,
          error: match.stringContaining(
            'baseline sweep aborted during fetchRef (first failure at pr 7): network down',
          ),
        },
      ],
      blocked: [],
    });
    expect(fake.calls).toEqual(['fetch:refs/pull/7/head']); // first fetch threw; run over
  });

  test('a stale ancestor blocks its descendants (rule c cascade, zero calls on them)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.heads.set(8, sha('b'));
    fake.driftSha = sha('c');
    const plan = stackPlan([planned(7, 'main', 'feat-7'), planned(8, 'feat-7', 'feat-8')]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.stale).toEqual([{ pr: 7, detail: match.any(String) }]);
    expect(report.blocked).toEqual([{ pr: 8, reason: 'blocked_by_ancestor' }]);
    expect(report.merged).toEqual([]);
    // Pr 8 was NEVER executed: the sweep fetched + validated its head
    // (2 calls) and the blocked action added nothing.
    expect(fake.calls.filter((call) => call.includes('pull/8')).length).toBe(2);
    expect(fake.calls.includes('prepare:8@refs/pull/8/head')).toBe(false);
  });
});

describe('executeMerges — (e) bounded retry on "base branch was modified"', () => {
  const baseModified = {
    code: 1,
    stdout: '',
    stderr: 'error: base branch was modified. Please try again.',
  };

  test('fails twice then succeeds → merged, revalidation between attempts', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [
      baseModified,
      { ...baseModified, stderr: 'Base branch was modified — retry' },
      OK,
    ]);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([7]);
    expect(report.failed).toEqual([]);
    expect(mergeCalls(fake).length).toBe(3);
    // The exact retry shape: attempt → FETCH+revalidate → attempt →
    // FETCH+revalidate → attempt (round 1: the between-attempt check
    // fetches first). Baseline + pre-merge + two between-attempt
    // revalidations = 4 validations total.
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head', // baseline fetch (CR-4)
      'validate:refs/pull/7/head', // baseline
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head', // pre-merge
      'merge:7:merge', // attempt 1 — base modified
      'fetch:refs/pull/7/head', // revalidation fetch FIRST (round 1)
      'validate:refs/pull/7/head', // revalidate
      'merge:7:merge', // attempt 2 — base modified
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'merge:7:merge', // attempt 3 — merged
    ]);
  });

  test('the cap is honored: default 3 retries → at most 4 attempts, then failed', async () => {
    expect(DEFAULT_MAX_RETRIES).toBe(3);
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified, baseModified, baseModified, baseModified]);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('base branch was modified') },
    ]);
    expect(mergeCalls(fake).length).toBe(4); // 1 attempt + 3 retries, never a 5th
  });

  test('an explicit maxRetries bounds the attempts too', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified, baseModified, baseModified]);

    const report = await executeMerges({
      plan: handPlan([entry(7)]),
      effects: fake,
      maxRetries: 1,
    });
    expect(mergeCalls(fake).length).toBe(2); // 1 attempt + 1 retry
    expect(report.failed).toEqual([{ pr: 7, error: match.any(String) }]);
  });

  test('a non-retryable failure is recorded immediately, never retried', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [{ code: 1, stdout: '', stderr: 'Merge blocked by branch protection' }]);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('Merge blocked by branch protection') },
    ]);
    expect(mergeCalls(fake)).toEqual(['merge:7:merge']); // exactly one attempt
    // No between-attempt revalidation ever ran (2 validations: baseline +
    // pre-merge only).
    expect(fake.calls.filter((call) => call.startsWith('validate:')).length).toBe(2);
  });

  test('a head that moves during a retry makes the action stale, not a blind retry', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified]);
    // Drift only from the THIRD validation: baseline (0) and the pre-merge
    // revalidation (1) still see the planned sha; the between-attempt
    // revalidation (2) sees the moved head.
    fake.driftSha = sha('z');
    fake.driftFromCall = 2;

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.stale).toEqual([
      { pr: 7, detail: match.stringContaining('moved while revalidating') },
    ]);
    expect(mergeCalls(fake).length).toBe(1);
  });

  test('round-1 blind-retry regression: a REMOTE head that moves mid-retry → stale, never a second attempt', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified]); // attempt 1 fails retryably
    // The remote's sha timeline: the first TWO fetches (baseline + pre-merge)
    // still report the planned sha; the between-attempt fetch is what
    // reveals the move — a local-only revalidation would have missed it.
    fake.remoteQueue.set(7, [sha('a'), sha('a'), sha('f')]);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.stale).toEqual([
      { pr: 7, detail: match.stringContaining('moved while revalidating') },
    ]);
    expect(mergeCalls(fake)).toEqual(['merge:7:merge']); // never a blind second attempt
    // The between-attempt check FETCHED first — the fetch is what the
    // validation then read the moved sha through.
    const afterFirstMerge = fake.calls.slice(fake.calls.indexOf('merge:7:merge') + 1);
    expect(afterFirstMerge).toEqual(['fetch:refs/pull/7/head', 'validate:refs/pull/7/head']);
  });

  test('a nonzero fetch during between-attempt revalidation → failed (never retried blind)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified]);
    // Fetch calls 0 (baseline) and 1 (pre-merge) pass; call 2 — the
    // between-attempt revalidation fetch — fails.
    fake.fetchFailFromCall.set(7, 2);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('retry revalidation: fetch') },
    ]);
    expect(mergeCalls(fake)).toEqual(['merge:7:merge']);
  });
});

describe('executeMerges — (c) failed ancestor blocks descendants, independent roots continue', () => {
  test('pr 7 fails → pr 8 blocked; independent root pr 9 still merges', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.heads.set(8, sha('b'));
    fake.heads.set(9, sha('c'));
    fake.mergeQueue.set(7, [{ code: 1, stdout: '', stderr: 'required statuses missing' }]);
    const plan = stackPlan([
      planned(7, 'main', 'feat-7'),
      planned(8, 'feat-7', 'feat-8'),
      planned(9, 'main', 'feat-9'),
    ]);
    // F2's order: roots [7, 9] first, then 7's subtree (8).
    expect(plan.order.map((e) => e.pr)).toEqual([7, 9, 8]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('required statuses missing') },
    ]);
    expect(report.merged).toEqual([9]);
    expect(report.blocked).toEqual([{ pr: 8, reason: 'blocked_by_ancestor' }]);
    expect(report.stale).toEqual([]);
    // Pr 8 was never EXECUTED: the sweep fetched + validated its head
    // (2 calls); the blocked action added nothing.
    expect(fake.calls.filter((call) => call.includes('pull/8/head')).length).toBe(2);
    expect(fake.calls.includes('merge:8:merge')).toBe(false);
    // The independent root continued after the failure, in plan order.
    expect(mergeCalls(fake)).toEqual(['merge:7:merge', 'merge:9:merge']);
  });
});

describe('withPreparedWorktree — the worktree lifecycle seam helper (round 1, finding 3)', () => {
  test("prepare → fn(path) → remove, in order; fn's value resolves", async () => {
    const fake = new FakeMergeEffects();
    const fnPaths: string[] = [];
    const result = await withPreparedWorktree(fake, 7, headRefFor(7), async (path) => {
      fnPaths.push(path);
      return 'resolved';
    });
    expect(result).toBe('resolved');
    expect(fnPaths).toEqual(['/wt/pr-7']);
    expect(fake.calls).toEqual(['prepare:7@refs/pull/7/head', 'remove:/wt/pr-7']);
  });

  test('fn throws → remove still runs, and the ORIGINAL error object is rethrown (never masked)', async () => {
    const fake = new FakeMergeEffects();
    const original = new Error('resolver exploded');
    await expect(
      withPreparedWorktree(fake, 7, headRefFor(7), async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(fake.calls).toEqual(['prepare:7@refs/pull/7/head', 'remove:/wt/pr-7']);
  });

  test('fn throws AND the removal fails → the removal note is APPENDED to the original error', async () => {
    const fake = new FakeMergeEffects();
    fake.removeFailures.add('/wt/pr-7');
    await expect(
      withPreparedWorktree(fake, 7, headRefFor(7), async () => {
        throw new Error('resolver exploded');
      }),
    ).rejects.toThrow(/resolver exploded; worktreeRemove \/wt\/pr-7 also failed/);
    expect(fake.calls).toEqual(['prepare:7@refs/pull/7/head', 'remove:/wt/pr-7']);
  });

  test("fn resolves but the removal fails → the caller's result still stands (never masked)", async () => {
    const fake = new FakeMergeEffects();
    fake.removeFailures.add('/wt/pr-7');
    const result = await withPreparedWorktree(fake, 7, headRefFor(7), async () => 'ok');
    expect(result).toBe('ok');
    expect(fake.calls).toEqual(['prepare:7@refs/pull/7/head', 'remove:/wt/pr-7']);
  });

  test('a prepare throw propagates untouched — fn never runs, remove never runs (finding 6)', async () => {
    const fake = new FakeMergeEffects();
    fake.prepareThrows = new Error('worktree add refused');
    let fnRan = false;
    await expect(
      withPreparedWorktree(fake, 7, headRefFor(7), async () => {
        fnRan = true;
        return 'never';
      }),
    ).rejects.toThrow('worktree add refused');
    expect(fnRan).toBe(false);
    // Nothing was prepared — there is nothing to remove.
    expect(fake.calls).toEqual(['prepare:7@refs/pull/7/head']);
  });
});

describe('executeMerges — the plan is the only source of actions', () => {
  test('needsHuman entries are NEVER executed (no effect call touches them)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.heads.set(3, sha('x')); // live head, but needs-human: still untouched
    const plan = handPlan([entry(7)], [{ pr: 3, reason: 'not_eligible' }]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.merged).toEqual([7]);
    // The full sequence mentions pr 7 only — pr 3 never validated, fetched,
    // prepared, merged, pushed, or removed.
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'merge:7:merge',
    ]);
    expect(JSON.stringify(report).includes('3')).toBe(false);
  });

  test('a retarget-self entry executes the forge base edit — never a merge, worktree, or push', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    const plan = handPlan([entry(5, 'retarget-self')]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.retargeted).toEqual([5]);
    expect(report.merged).toEqual([]);
    // The retarget rides the forge base edit ONLY (CR1): after the baseline
    // fetch+validate and the drift guard, retargetBase(pr, baseBranch) —
    // no prepare, no push, no remove.
    expect(fake.calls).toEqual([
      'fetch:refs/pull/5/head',
      'validate:refs/pull/5/head',
      'fetch:refs/pull/5/head',
      'validate:refs/pull/5/head',
      'retarget:5:base=main',
    ]);
    expect(fake.calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

  test('a failed forge retarget lands in failed — no worktree was ever involved', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.retargetFailures.add(5);

    const report = await executeMerges({
      plan: handPlan([entry(5, 'retarget-self')]),
      effects: fake,
    });

    expect(report.retargeted).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 5, error: match.stringContaining('gh pr edit 5 --base main') },
    ]);
    expect(
      fake.calls.some((call) => call.startsWith('prepare:') || call.startsWith('remove:')),
    ).toBe(false);
  });

  test('round-1 finding 6: an action-time fetch failure → failed with the error, never merged', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.fetchFailures.add(7); // every fetch for pr 7 fails

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    // The BASELINE fetch is best-effort (tolerated — the sweep validate
    // still saw the locally-known head); the ACTION fetch failing is fatal
    // to the action: failed, never merged.
    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('fatal: could not read from remote repository') },
    ]);
    expect(report.merged).toEqual([]);
    expect(mergeCalls(fake)).toEqual([]);
    expect(fake.calls.filter((call) => call.startsWith('fetch:')).length).toBe(2); // baseline + action
  });

  test('round-1 finding 6: drift on a retarget-self entry → skipped stale; retargetBase never called', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.driftSha = sha('b'); // every validation after the baseline sees the moved head

    const report = await executeMerges({
      plan: handPlan([entry(5, 'retarget-self')]),
      effects: fake,
    });

    expect(report.retargeted).toEqual([]);
    expect(report.stale).toEqual([
      { pr: 5, detail: match.stringContaining('moved between plan and run') },
    ]);
    expect(fake.calls.some((call) => call.startsWith('retarget:'))).toBe(false);
  });

  test('CR1 regression: a forge that rejects pull-ref pushes never receives one from a retarget', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.pushFailures.add(5); // the hostile forge: any push would be recorded AND rejected

    const report = await executeMerges({
      plan: handPlan([entry(5, 'retarget-self')]),
      effects: fake,
    });

    expect(report.retargeted).toEqual([5]);
    // The OLD shape pushed the read-only refs/pull/<n>/head — GitHub rejects
    // that. The pin: NO pushRef call happens anywhere in the retarget flow,
    // pull-ref or otherwise; the retarget rides the forge base edit only.
    const pushedRefs = fake.calls
      .filter((call) => call.startsWith('push:'))
      .map((call) => call.slice('push:'.length).split('@')[0])
      .filter((ref): ref is string => ref !== undefined);
    expect(pushedRefs).toEqual([]);
    expect(pushedRefs.some((ref) => ref.startsWith('refs/pull/'))).toBe(false);
    expect(fake.calls).toContain('retarget:5:base=main');
  });

  test('CR1 totality: an effects throw at the baseline fails the run wholesale — total report, nothing executed', async () => {
    const fake = new FakeMergeEffects();
    fake.validateThrows = new Error('spawn boom');
    const plan = handPlan([entry(7), entry(8)]);

    const report = await executeMerges({ plan, effects: fake });

    // Resolves (no unhandled rejection) with EVERY planned pr failed and
    // nothing else executed — the run-scoped wholesale wording (round 2,
    // finding 4) names the phase and the pr it aborted on, for every record.
    expect(report).toEqual({
      merged: [],
      retargeted: [],
      stale: [],
      failed: [
        {
          pr: 7,
          error: match.stringContaining(
            'baseline sweep aborted during validateRef (first failure at pr 7): spawn boom',
          ),
        },
        {
          pr: 8,
          error: match.stringContaining(
            'baseline sweep aborted during validateRef (first failure at pr 7): spawn boom',
          ),
        },
      ],
      blocked: [],
    });
    // The fetch PHASE ran to completion (both heads fetched, CR-4), then
    // the VALIDATE phase threw on the first probe.
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head',
      'fetch:refs/pull/8/head',
      'validate:refs/pull/7/head',
    ]);
  });
});

describe('executeMerges — (d) per-effective-base serial order, recorded in call order', () => {
  test('independent roots run strictly serially in plan order', async () => {
    const fake = new FakeMergeEffects();
    for (const pr of [5, 6]) fake.heads.set(pr, sha(String(pr)));
    const plan = stackPlan([planned(5, 'main', 'feat-5'), planned(6, 'main', 'feat-6')]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.merged).toEqual([5, 6]);
    // One action at a time, plan order, each fetch→validate→merge block
    // complete before the next begins (the whole-run serialization;
    // per-base grouping is preserved by the same order in the report).
    expect(fake.calls).toEqual([
      'fetch:refs/pull/5/head', // baseline sweep — fetch first (CR-4)
      'fetch:refs/pull/6/head',
      'validate:refs/pull/5/head',
      'validate:refs/pull/6/head',
      'fetch:refs/pull/5/head',
      'validate:refs/pull/5/head',
      'merge:5:merge',
      'fetch:refs/pull/6/head',
      'validate:refs/pull/6/head',
      'merge:6:merge',
    ]);
  });
});

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

describe('realMergeEffects.worktreePrepare — the git-common-dir root (round 2, finding 2)', () => {
  test('a linked-worktree repo (.git is a FILE) prepares under the ANSWERED common dir', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cq-merge-commondir-'));
    try {
      const repoRoot = join(tmp, 'repo');
      const realCommon = join(tmp, 'real-gitdir');
      await mkdir(repoRoot, { recursive: true });
      await mkdir(realCommon, { recursive: true });
      // The linked-worktree layout: .git is a FILE pointing at the gitdir.
      await writeFile(join(repoRoot, '.git'), `gitdir: ${join(tmp, 'worktrees-dir')}\n`, 'utf8');

      const gitCalls: string[][] = [];
      const effects = realMergeEffects({
        repoRoot,
        gitRun: async (args: string[]) => {
          gitCalls.push(args);
          if (args.includes('--git-common-dir')) {
            return { code: 0, stdout: `${realCommon}\n`, stderr: '' };
          }
          return OK; // the `worktree add` "succeeds"
        },
      });

      const { path } = await effects.worktreePrepare(7, 'refs/pull/7/head');

      // The tree lives under the ANSWERED common dir — never <repoRoot>/.git
      // (a file there: the old join threw ENOTDIR in exactly this layout).
      expect(path).toBe(join(realCommon, 'cq-merge-worktrees', 'pr-7'));
      expect(existsSync(join(realCommon, 'cq-merge-worktrees'))).toBe(true);
      expect(gitCalls).toEqual([
        ['-C', repoRoot, 'rev-parse', '--git-common-dir'],
        ['-C', repoRoot, 'worktree', 'add', '-B', 'cq-merge/pr-7', path, 'refs/pull/7/head'],
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a failed common-dir probe falls back to <repoRoot>/.git (the main-checkout layout)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cq-merge-commondir-'));
    try {
      const repoRoot = join(tmp, 'repo');
      await mkdir(join(repoRoot, '.git'), { recursive: true }); // a real .git DIR
      const effects = realMergeEffects({
        repoRoot,
        gitRun: async (args: string[]) =>
          args.includes('--git-common-dir')
            ? { code: 128, stdout: '', stderr: 'not a repository' }
            : OK,
      });

      const { path } = await effects.worktreePrepare(7, 'refs/pull/7/head');

      expect(path).toBe(join(repoRoot, '.git', 'cq-merge-worktrees', 'pr-7'));
      expect(existsSync(join(repoRoot, '.git', 'cq-merge-worktrees'))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('executeMerges — rejecting effects and the transitive cascade (round 2, finding 5)', () => {
  test('a rejecting mergePr → failed; the report stays total', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeThrows = new Error('spawn enoent');

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('mergePr for pr 7 threw: spawn enoent') },
    ]);
    expect(report.merged).toEqual([]);
  });

  test('a rejecting retargetBase → failed', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.retargetThrows = new Error('gh went away');

    const report = await executeMerges({
      plan: handPlan([entry(5, 'retarget-self')]),
      effects: fake,
    });

    expect(report.failed).toEqual([
      { pr: 5, error: match.stringContaining('retargetBase for pr 5 threw: gh went away') },
    ]);
    expect(report.retargeted).toEqual([]);
  });

  test('a transitive cascade — the GRANDCHILD of a failed ancestor is blocked, never executed', async () => {
    const fake = new FakeMergeEffects();
    for (const pr of [7, 8, 9]) fake.heads.set(pr, sha(String(pr)));
    fake.mergeQueue.set(7, [{ code: 1, stdout: '', stderr: 'blocked by protection' }]);
    const plan = stackPlan([
      planned(7, 'main', 'feat-7'),
      planned(8, 'feat-7', 'feat-8'),
      planned(9, 'feat-8', 'feat-9'),
    ]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.failed).toEqual([{ pr: 7, error: match.any(String) }]);
    expect(report.blocked).toEqual([
      { pr: 8, reason: 'blocked_by_ancestor' },
      { pr: 9, reason: 'blocked_by_ancestor' },
    ]);
    expect(report.merged).toEqual([]);
    // Only the root was ever attempted — 8 and 9 were never executed.
    expect(mergeCalls(fake)).toEqual(['merge:7:merge']);
  });

  test('a RETARGETED ancestor does not withhold its merge descendant', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.heads.set(6, sha('b'));
    const plan = handPlan([entry(5, 'retarget-self'), entry(6, 'merge', 5, 1)]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.retargeted).toEqual([5]);
    expect(report.merged).toEqual([6]);
    expect(report.blocked).toEqual([]);
  });

  test('round-3 finding 4: a FAILED retarget blocks its merge descendant', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.heads.set(6, sha('b'));
    fake.retargetFailures.add(5);
    const plan = handPlan([entry(5, 'retarget-self'), entry(6, 'merge', 5, 1)]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.failed).toEqual([
      { pr: 5, error: match.stringContaining('gh pr edit 5 --base main') },
    ]);
    expect(report.blocked).toEqual([{ pr: 6, reason: 'blocked_by_ancestor' }]);
    expect(report.retargeted).toEqual([]);
    expect(report.merged).toEqual([]);
    // Zero effect calls on 6 beyond the mandatory baseline sweep (one
    // fetch + one validate): the withheld cascade fired before any action.
    expect(fake.calls.filter((call) => call.includes('pull/6')).length).toBe(2);
    expect(fake.calls.includes('merge:6:merge')).toBe(false);
    expect(fake.calls.some((call) => call.startsWith('retarget:6'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// diagnoseMergeFailure (UC §3 row 45)
// ---------------------------------------------------------------------------

describe('diagnoseMergeFailure', () => {
  const mixed: ExecutionReport = {
    merged: [1, 4],
    retargeted: [3],
    stale: [{ pr: 9, detail: 'head moved between plan and run (plan saw aa, live is bb)' }],
    failed: [{ pr: 2, error: 'gh pr merge 2 --merge failed (exit 1): protected branch' }],
    blocked: [{ pr: 7, reason: 'blocked_by_ancestor' }],
  };

  test('each not-merged bucket maps to its plain-language cause, pr-number sorted', () => {
    const diagnosis = diagnoseMergeFailure(mixed);
    expect(diagnosis.causes).toEqual([
      { pr: 2, cause: 'merge_rejected' },
      { pr: 7, cause: 'blocked_by_ancestor' },
      { pr: 9, cause: 'state_drift' },
    ]);
    expect(diagnosis.needsHuman).toEqual([2, 7, 9]);
  });

  test('the summary line carries every count', () => {
    expect(diagnoseMergeFailure(mixed).summary).toBe(
      'merge run: 2 merged, 1 retargeted, 3 need a human ' +
        '(state_drift: 1, merge_rejected: 1, blocked_by_ancestor: 1)',
    );
  });

  test('a clean report diagnoses nothing to do', () => {
    const diagnosis = diagnoseMergeFailure({
      merged: [1],
      retargeted: [],
      stale: [],
      failed: [],
      blocked: [],
    });
    expect(diagnosis.causes).toEqual([]);
    expect(diagnosis.needsHuman).toEqual([]);
    expect(diagnosis.summary).toBe(
      'merge run: 1 merged, 0 retargeted, 0 need a human ' +
        '(state_drift: 0, merge_rejected: 0, blocked_by_ancestor: 0)',
    );
  });

  test('pure: same report → deep-equal diagnosis', () => {
    expect(diagnoseMergeFailure(mixed)).toEqual(diagnoseMergeFailure(mixed));
  });
});

describe('realMergeEffects gh spawn scoping — the real makeGhRunner over a recording fake gh (review-debt #163)', () => {
  test('realMergeEffects scopes the gh spawn to the repo root and strips an inherited GH_REPO (review-debt #163: no wrong-repo PRs on cwd/GH_REPO collisions)', async () => {
    // The REAL makeGhRunner (no run override — that would hide the spawn
    // opts) with a fake gh binary that records its cwd AND its GH_REPO: the
    // effect must spawn INSIDE repoRoot even though the test process cwd is
    // elsewhere, and an inherited GH_REPO (gh's repo resolution: -R >
    // GH_REPO > cwd) must be stripped — the cwd is otherwise defeated.
    const tmp = await mkdtemp(join(tmpdir(), 'cq-merge-ghcwd-'));
    const repo = join(tmp, 'repo');
    const record = join(tmp, 'cwd.txt');
    const ghRepoRecord = join(tmp, 'ghrepo.txt');
    await mkdir(repo);
    const gh = join(tmp, 'fake-gh.sh');
    await writeFile(
      gh,
      `#!/bin/sh\nprintf '%s' "$PWD" > '${record}'\nprintf '%s' "$GH_REPO" > '${ghRepoRecord}'\n`,
    );
    chmodSync(gh, 0o755);
    const previousGhRepo = process.env.GH_REPO;
    process.env.GH_REPO = 'wrong-owner/wrong-repo';
    try {
      const effects = realMergeEffects({ repoRoot: repo, ghBin: gh });
      expect(await effects.retargetBase(7, 'other')).toMatchObject({ code: 0 });
      // Compare REAL paths: on macOS os.tmpdir() hands out the logical
      // /var/... spelling of a symlinked directory, and sh's $PWD keeps
      // that logical form while node may hand the physical one — the
      // contract is "same directory", not "same spelling".
      const { readFile, realpath: realpathFsp } = await import('node:fs/promises');
      expect(await realpathFsp(await readFile(record, 'utf8'))).toBe(await realpathFsp(repo));
      expect(await readFile(ghRepoRecord, 'utf8')).toBe('');
    } finally {
      if (previousGhRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = previousGhRepo;
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
