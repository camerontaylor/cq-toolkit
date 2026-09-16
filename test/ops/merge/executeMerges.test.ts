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
//   3. LIVE-STATE REVALIDATION (a): the baseline sweep reads each planned
//      head once, then each action fetches + revalidates; a head that
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
//   8. WORKTREES REMOVED IN FINALLY (f): remove happens even when the
//      merge fails; a removal failure is appended to the record, never
//      masks the primary outcome, and never rewrites a clean merge.
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
import { describe, expect, test } from 'vitest';
import { DEFAULT_MAX_RETRIES, executeMerges } from '../../../src/ops/merge/executeMerges.js';
import type { ExecutionReport } from '../../../src/ops/merge/executeMerges.js';
import { diagnoseMergeFailure } from '../../../src/ops/merge/diagnoseMergeFailure.js';
import {
  UnsafeMergeArgsError,
  headRefFor,
  realMergeEffects,
  safeArgs,
  safeRunner,
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
  return match === null ? null : Number.parseInt(match[1], 10);
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

  async validateRef(ref: string): Promise<{ ok: boolean; sha?: string }> {
    this.calls.push(`validate:${ref}`);
    if (this.validateThrows !== null) throw this.validateThrows;
    const pr = prOfRef(ref);
    if (pr === null) return { ok: false };
    const seen = this.validateCalls.get(pr) ?? 0;
    this.validateCalls.set(pr, seen + 1);
    const live = this.heads.get(pr);
    if (live === undefined) return { ok: false };
    if (this.driftSha !== null && seen >= this.driftFromCall) return { ok: true, sha: this.driftSha };
    return { ok: true, sha: live };
  }

  async fetchRef(ref: string): Promise<GhResult> {
    this.calls.push(`fetch:${ref}`);
    const pr = prOfRef(ref);
    if (pr !== null && this.fetchFailures.has(pr)) {
      return { code: 1, stdout: '', stderr: 'fatal: could not read from remote repository' };
    }
    return OK;
  }

  async worktreePrepare(pr: number, ref: string): Promise<{ path: string }> {
    this.calls.push(`prepare:${String(pr)}@${ref}`);
    return { path: `/wt/pr-${String(pr)}` };
  }

  async worktreeRemove(path: string): Promise<void> {
    this.calls.push(`remove:${path}`);
    if (this.removeFailures.has(path)) {
      throw new Error(`worktree remove ${path} refused (tree is dirty)`);
    }
  }

  async mergePr(pr: number, opts: { method: 'merge' }): Promise<GhResult> {
    this.calls.push(`merge:${String(pr)}:${opts.method}`);
    const next = this.mergeQueue.get(pr)?.shift();
    return next ?? OK;
  }

  async retargetBase(pr: number, newBase: string): Promise<GhResult> {
    this.calls.push(`retarget:${String(pr)}:base=${newBase}`);
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
    // The EXACT sequence: baseline sweep first (one validate per planned
    // head), then per action fetch → revalidate → prepare → merge →
    // remove, parents strictly before children (rules a, d, f).
    expect(fake.calls).toEqual([
      'validate:refs/pull/7/head', // baseline sweep
      'validate:refs/pull/8/head',
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head', // live-state revalidation
      'prepare:7@refs/pull/7/head',
      'merge:7:merge', // method 'merge' only (I3)
      'remove:/wt/pr-7',
      'fetch:refs/pull/8/head',
      'validate:refs/pull/8/head',
      'prepare:8@refs/pull/8/head',
      'merge:8:merge',
      'remove:/wt/pr-8',
    ]);
  });

  test('an empty plan executes nothing and reports nothing', async () => {
    const fake = new FakeMergeEffects();
    const report = await executeMerges({ plan: handPlan([]), effects: fake });
    expect(report).toEqual({ merged: [], retargeted: [], stale: [], failed: [], blocked: [] });
    expect(fake.calls).toEqual([]);
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
      { pr: 7, detail: expect.stringContaining('moved between plan and run') },
    ]);
    expect(report.failed).toEqual([]);
    // The exact calls prove it: baseline (sha a) → fetch → revalidate
    // (sha b ≠ a) → skipped. No prepare, no merge, no remove.
    expect(fake.calls).toEqual([
      'validate:refs/pull/7/head',
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
    ]);
  });

  test('a head unresolvable at execution start → stale before any action', async () => {
    const fake = new FakeMergeEffects(); // heads map empty: ref unknown
    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });
    expect(report.stale).toEqual([
      { pr: 7, detail: 'head ref unresolvable when execution started' },
    ]);
    expect(fake.calls).toEqual(['validate:refs/pull/7/head']);
  });

  test('a stale ancestor blocks its descendants (rule c cascade, zero calls on them)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.heads.set(8, sha('b'));
    fake.driftSha = sha('c');
    const plan = stackPlan([planned(7, 'main', 'feat-7'), planned(8, 'feat-7', 'feat-8')]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.stale).toEqual([{ pr: 7, detail: expect.any(String) }]);
    expect(report.blocked).toEqual([{ pr: 8, reason: 'blocked_by_ancestor' }]);
    expect(report.merged).toEqual([]);
    // Pr 8 was NEVER touched: no fetch, no validate beyond the sweep, no
    // worktree, no merge.
    expect(fake.calls.some((call) => call.includes('pull/8'))).toBe(true); // the sweep only
    expect(fake.calls.filter((call) => call.includes('pull/8')).length).toBe(1);
    expect(fake.calls.includes('prepare:8@refs/pull/8/head')).toBe(false);
  });
});

describe('executeMerges — (e) bounded retry on "base branch was modified"', () => {
  const baseModified = { code: 1, stdout: '', stderr: 'error: base branch was modified. Please try again.' };

  test('fails twice then succeeds → merged, revalidation between attempts', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified, { ...baseModified, stderr: 'Base branch was modified — retry' }, OK]);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([7]);
    expect(report.failed).toEqual([]);
    expect(mergeCalls(fake).length).toBe(3);
    // The exact retry shape: attempt → revalidate → attempt → revalidate →
    // attempt. Baseline + pre-merge + two between-attempt revalidations = 4
    // validations total.
    expect(fake.calls).toEqual([
      'validate:refs/pull/7/head', // baseline
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head', // pre-merge
      'prepare:7@refs/pull/7/head',
      'merge:7:merge', // attempt 1 — base modified
      'validate:refs/pull/7/head', // revalidate
      'merge:7:merge', // attempt 2 — base modified
      'validate:refs/pull/7/head', // revalidate
      'merge:7:merge', // attempt 3 — merged
      'remove:/wt/pr-7',
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
      { pr: 7, error: expect.stringContaining('base branch was modified') },
    ]);
    expect(mergeCalls(fake).length).toBe(4); // 1 attempt + 3 retries, never a 5th
  });

  test('an explicit maxRetries bounds the attempts too', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified, baseModified, baseModified]);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake, maxRetries: 1 });
    expect(mergeCalls(fake).length).toBe(2); // 1 attempt + 1 retry
    expect(report.failed).toEqual([{ pr: 7, error: expect.any(String) }]);
  });

  test('a non-retryable failure is recorded immediately, never retried', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [{ code: 1, stdout: '', stderr: 'Merge blocked by branch protection' }]);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 7, error: expect.stringContaining('Merge blocked by branch protection') },
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
      { pr: 7, detail: expect.stringContaining('moved while revalidating') },
    ]);
    expect(mergeCalls(fake).length).toBe(1);
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

    expect(report.failed).toEqual([{ pr: 7, error: expect.stringContaining('required statuses missing') }]);
    expect(report.merged).toEqual([9]);
    expect(report.blocked).toEqual([{ pr: 8, reason: 'blocked_by_ancestor' }]);
    expect(report.stale).toEqual([]);
    // Pr 8 was never executed in any way.
    expect(fake.calls.some((call) => call.includes('pull/8/head') && !call.startsWith('validate:'))).toBe(false);
    expect(fake.calls.includes('prepare:8@refs/pull/8/head')).toBe(false);
    // The independent root continued after the failure, in plan order.
    expect(mergeCalls(fake)).toEqual(['merge:7:merge', 'merge:9:merge']);
  });
});

describe('executeMerges — (f) worktrees removed in finally', () => {
  test('the removal happens even when the merge fails', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [{ code: 1, stdout: '', stderr: 'nope' }]);

    await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    const prepareAt = fake.calls.findIndex((call) => call.startsWith('prepare:'));
    const removeAt = fake.calls.findIndex((call) => call.startsWith('remove:'));
    expect(prepareAt).toBeGreaterThanOrEqual(0);
    expect(removeAt).toBeGreaterThan(prepareAt); // paired, after the failed merge
  });

  test('a removal failure is appended to the record — it never masks the primary failure', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [{ code: 1, stdout: '', stderr: 'merge disallowed' }]);
    fake.removeFailures.add('/wt/pr-7');

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.failed).toEqual([
      {
        pr: 7,
        error: expect.stringMatching(/merge disallowed; worktreeRemove \/wt\/pr-7 also failed/),
      },
    ]);
  });

  test('a removal failure after a clean merge never rewrites the outcome', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.removeFailures.add('/wt/pr-7');

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([7]);
    expect(report.failed).toEqual([]);
    expect(report.stale).toEqual([]);
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
      'validate:refs/pull/7/head',
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'prepare:7@refs/pull/7/head',
      'merge:7:merge',
      'remove:/wt/pr-7',
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
    // The retarget rides the forge base edit ONLY (CR1): after the drift
    // guard, retargetBase(pr, baseBranch) — no prepare, no push, no remove.
    expect(fake.calls).toEqual([
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

    const report = await executeMerges({ plan: handPlan([entry(5, 'retarget-self')]), effects: fake });

    expect(report.retargeted).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 5, error: expect.stringContaining('gh pr edit 5 --base main') },
    ]);
    expect(fake.calls.some((call) => call.startsWith('prepare:') || call.startsWith('remove:'))).toBe(
      false,
    );
  });

  test('CR1 regression: a forge that rejects pull-ref pushes never receives one from a retarget', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.pushFailures.add(5); // the hostile forge: any push would be recorded AND rejected

    const report = await executeMerges({ plan: handPlan([entry(5, 'retarget-self')]), effects: fake });

    expect(report.retargeted).toEqual([5]);
    // The OLD shape pushed the read-only refs/pull/<n>/head — GitHub rejects
    // that. The pin: NO pushRef call happens anywhere in the retarget flow,
    // pull-ref or otherwise; the retarget rides the forge base edit only.
    const pushedRefs = fake.calls
      .filter((call) => call.startsWith('push:'))
      .map((call) => call.slice('push:'.length).split('@')[0]);
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
    // nothing else executed.
    expect(report).toEqual({
      merged: [],
      retargeted: [],
      stale: [],
      failed: [
        { pr: 7, error: expect.stringContaining('spawn boom') },
        { pr: 8, error: expect.stringContaining('spawn boom') },
      ],
      blocked: [],
    });
    expect(fake.calls).toEqual(['validate:refs/pull/7/head']); // first probe threw; run over
  });
});

describe('executeMerges — (d) per-effective-base serial order, recorded in call order', () => {
  test('independent roots run strictly serially in plan order', async () => {
    const fake = new FakeMergeEffects();
    for (const pr of [5, 6]) fake.heads.set(pr, sha(String(pr)));
    const plan = stackPlan([planned(5, 'main', 'feat-5'), planned(6, 'main', 'feat-6')]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.merged).toEqual([5, 6]);
    // One action at a time, plan order, each prepare→merge→remove block
    // complete before the next begins (the whole-run serialization;
    // per-base grouping is preserved by the same order in the report).
    expect(fake.calls).toEqual([
      'validate:refs/pull/5/head',
      'validate:refs/pull/6/head',
      'fetch:refs/pull/5/head',
      'validate:refs/pull/5/head',
      'prepare:5@refs/pull/5/head',
      'merge:5:merge',
      'remove:/wt/pr-5',
      'fetch:refs/pull/6/head',
      'validate:refs/pull/6/head',
      'prepare:6@refs/pull/6/head',
      'merge:6:merge',
      'remove:/wt/pr-6',
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

  test("-f throws", () => {
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
    expect(() => safeArgs(['push', 'origin', 'feat:refs/heads/main'])).toThrow(UnsafeMergeArgsError);
    expect(() => safeArgs(['-C', '/repo', 'push', 'origin', ':main'])).toThrow(UnsafeMergeArgsError);
  });

  test('the executor’s own argv shapes pass untouched', () => {
    expect(safeArgs(['pr', 'merge', '7', '--merge'])).toEqual(['pr', 'merge', '7', '--merge']);
    expect(safeArgs(['-C', '/repo', 'fetch', 'origin', '+refs/pull/7/head:refs/pull/7/head'])).toEqual([
      '-C',
      '/repo',
      'fetch',
      'origin',
      '+refs/pull/7/head:refs/pull/7/head',
    ]);
    expect(
      safeArgs(['-C', '/repo', 'worktree', 'add', '-B', 'cq-merge/pr-7', '/wt/pr-7', 'refs/pull/7/head']),
    ).toEqual(['-C', '/repo', 'worktree', 'add', '-B', 'cq-merge/pr-7', '/wt/pr-7', 'refs/pull/7/head']);
    expect(safeArgs(['-C', '/wt/pr-7', 'push', 'origin', 'refs/pull/7/head'])).toEqual([
      '-C',
      '/wt/pr-7',
      'push',
      'origin',
      'refs/pull/7/head',
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
    expect(ghCalls).toEqual([['pr', 'merge', '7', '--merge']]);
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
    await effects.pushRef('refs/pull/7/head', '/wt/pr-7');
    expect(gitCalls).toEqual([
      ['-C', '/repo', 'rev-parse', '--verify', '--quiet', 'refs/pull/7/head^{commit}'],
      ['-C', '/repo', 'fetch', 'origin', '+refs/pull/7/head:refs/pull/7/head'],
      ['-C', '/wt/pr-7', 'push', 'origin', 'refs/pull/7/head'],
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

// ---------------------------------------------------------------------------
// diagnoseMergeFailure (UC §3 row 45)
// ---------------------------------------------------------------------------

describe('diagnoseMergeFailure', () => {
  const mixed: ExecutionReport = {
    merged: [1, 2],
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
