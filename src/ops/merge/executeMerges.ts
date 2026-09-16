// executeMerges — the F2 plan's executor (goal F3, ws-f scope item 3;
// UC §3 row 43). The plan is the ONLY source of actions: exactly the
// entries in `plan.order` are acted on — 'merge' entries merge SERVER-SIDE
// (gh pr merge; merge entries do NOT touch worktrees — round 1; worktree
// lifecycle enters with F4's conflict resolver via withPreparedWorktree in
// effects.js), 'retarget-self' entries are retargeted onto the plan's base
// branch by a FORGE BASE EDIT (retargetBase; a retarget never touches a
// worktree and never pushes a ref) — and `plan.needsHuman` entries are
// NEVER executed (I2 carries through execution: a PR a human owes is not
// merged by a machine). The executor is pure orchestration: every git/gh
// mutation rides the injected MergeEffects seam (see ./effects.js — UC row
// 43's load-bearing point: the whole flow is testable with ZERO real
// git/gh), so this module contains no transport, no spawning, no fs.
//
// THE SEMANTICS, each pinned by a test:
//   a. LIVE-STATE REVALIDATION per action — before merging PR N, its head
//      ref (refs/pull/<n>/head, the PR-number-addressable truth) is
//      validated against the BASELINE: the executor's first observation of
//      each planned head, taken in one FETCH-THEN-VALIDATE sweep before
//      any action runs (the observable stand-in for "the sha the plan was
//      built on" — the executor is invoked directly after planning on the
//      same live state, and the plan itself carries no shas). The fetch
//      comes FIRST (CR-4): a fresh clone has no local refs/pull ref until
//      it is fetched, so a validate-before-fetch would read every pr
//      stale. A head that moved between the baseline and the merge — or
//      vanished, even after its fetch — is drift between classify/plan
//      and merge: the action is SKIPPED as `stale`, never merged, the
//      reason recorded.
//   b. MERGE COMMITS ONLY (I3) — mergePr is called with method 'merge'
//      exclusively; the production effects route every argv through
//      safeArgs (./effects.js), which throws on squash/force/rebase/hard/
//      push-to-protected-branch (default 'main') before any process
//      exists.
//   c. FAILED ANCESTOR BLOCKS DESCENDANTS — the order is in dependency
//      order (F2 guarantees parents before children); once an entry ends
//      stale or failed (or was blocked itself), every LATER entry in its
//      stack lineage is recorded `blocked_by_ancestor` WITHOUT any effect
//      call — merging a child whose base did not merge would merge the
//      base's commits UNINVITED. Independent roots continue.
//   d. PER-EFFECTIVE-BASE MUTEX — actions sharing an effective base (a
//      basePr, else the plan's base branch) run serially in order under a
//      per-key async mutex. Cross-base actions COULD parallelize; this
//      implementation additionally processes plan.order strictly
//      sequentially, serializing ALL actions for determinism (same plan +
//      same effects behavior → same report, always), and the per-base
//      grouping survives in the report: each bucket preserves plan order.
//   e. BOUNDED RETRY — a merge failure whose stderr matches
//      /base branch was modified/i is retried up to `maxRetries`
//      (default 3, so at most maxRetries + 1 mergePr calls), with the
//      head revalidated between attempts — FETCH FIRST (round 1): the
//      remote may have moved without any local ref knowing, so a blind
//      retry would merge against the drifted base; a nonzero fetch →
//      failed, a sha that moved or vanished after the fetch → stale. ANY
//      other failure is recorded `failed` immediately and NOT retried.
//   f. WORKTREES ARE NOT THIS EXECUTOR'S BUSINESS (round 1) — gh pr merge
//      is server-side, so merge entries prepare and remove NOTHING; the
//      old per-action prepare/remove pair cost two git calls and added a
//      spurious failure mode ahead of the merge attempt. Worktree
//      lifecycle enters with F4's conflict resolver via
//      withPreparedWorktree (effects.js): prepare → fn → remove-in-finally,
//      a removal failure never masking the caller's outcome.
//
// TOTALITY: every PR in plan.order lands in EXACTLY ONE of merged /
// retargeted / stale / failed / blocked. Effect methods that REJECT
// (a misbehaving fake, a spawn-level throw) are caught and recorded as
// `failed` — the report is total by construction, not by optimism. This
// includes the baseline sweep (CR1): a validateRef THROW at startup fails
// the run WHOLESALE — nothing executes and every planned pr is recorded
// `failed` with the error, so the report is still total. (The planner's
// duplicate_pr gate guarantees one entry per pr; executeMerges relies on
// that and does not re-guard.)
import type { GhResult } from '../review/gh.js';
import type { MergeEffects } from './effects.js';
import { headRefFor } from './effects.js';
import type { PlannedMergeEntry, PlanMergeResult } from './planMergeOrder.js';

/** Retries default to 3 when `maxRetries` is omitted (at most 4 mergePr
 * calls per action: 1 attempt + 3 retries). */
export const DEFAULT_MAX_RETRIES = 3;

/** Why an entry was blocked without executing — stable snake_case, one
 * value, mirroring the family's frozen-vocabulary discipline. */
export type ExecutionBlockReason = 'blocked_by_ancestor';

/** The run's outcome: every plan.order pr appears in EXACTLY ONE bucket.
 * Buckets preserve plan (execution) order. */
export interface ExecutionReport {
  /** PRs merged with method 'merge' (I3), in execution order. */
  merged: number[];
  /** retarget-self entries whose base was retargeted on the forge (the
   * retargetBase edit — never a push), in execution order. */
  retargeted: number[];
  /** PRs skipped because the live state drifted from what the plan was
   * built on (or the head ref vanished) — never merged. */
  stale: Array<{ pr: number; detail: string }>;
  /** PRs whose execution failed (fetch unavailable, merge refused, effect
   * threw) — recorded, not retried beyond rule (e)'s bound. */
  failed: Array<{ pr: number; error: string }>;
  /** PRs not executed because a stack ancestor did not merge. */
  blocked: Array<{ pr: number; reason: ExecutionBlockReason }>;
}

/** The executor's input: an F2 plan (the ONLY source of actions), the
 * effects seam, and the bounded-retry budget. */
export interface ExecuteMergeInput {
  /** The plan to execute — planMergeOrder's output, taken as gospel. */
  plan: PlanMergeResult;
  /** Every git/gh mutation goes through this seam (UC row 43). */
  effects: MergeEffects;
  /** Retries per merge action after the first attempt; default
   * DEFAULT_MAX_RETRIES. */
  maxRetries?: number;
}

/** One action's decided outcome, before it is filed into the report. */
type Outcome =
  | { kind: 'merged' }
  | { kind: 'retargeted' }
  | { kind: 'stale'; detail: string }
  | { kind: 'failed'; error: string };

/** One async mutex: callers queue behind the previous holder's promise,
 * whatever its outcome. This is rule (d)'s per-effective-base primitive —
 * small on purpose; the executor's strictly sequential loop is the outer
 * serialization, and this key keeps the seam honest if actions are ever
 * dispatched concurrently. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** stderr as a message suffix (empty stderr adds nothing). */
const stderrSuffix = (stderr: string): string => {
  const trimmed = stderr.trim();
  return trimmed === '' ? '' : `: ${trimmed}`;
};

/** The bounded-retry trigger (rule e): GitHub's base-moved refusal. */
const RETRYABLE_MERGE_FAILURE = /base branch was modified/i;

/**
 * Execute the F2 plan through the injected effects. See the module doc for
 * semantics (a)–(f); the returned report is total — every plan.order pr in
 * exactly one bucket, each bucket in plan order.
 */
export async function executeMerges(input: ExecuteMergeInput): Promise<ExecutionReport> {
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
  const { plan, effects } = input;
  const report: ExecutionReport = {
    merged: [],
    retargeted: [],
    stale: [],
    failed: [],
    blocked: [],
  };

  // (d) the per-effective-base mutexes: a base PR is a key of its own,
  // the plan's base branch is the key for root-position entries.
  const baseMutexes = new Map<string, Mutex>();
  const mutexFor = (key: string): Mutex => {
    const existing = baseMutexes.get(key);
    if (existing !== undefined) return existing;
    const created = new Mutex();
    baseMutexes.set(key, created);
    return created;
  };
  const effectiveBaseKey = (entry: PlannedMergeEntry): string =>
    entry.basePr !== null ? `pr:${String(entry.basePr)}` : `branch:${plan.baseBranch}`;

  // (a) THE BASELINE SWEEP — FETCH, THEN VALIDATE (CR-4). Phase 1 fetches
  // each planned head: a fresh clone has NO local refs/pull/<n>/head until
  // it is fetched, so validating first would read every pr stale. The
  // fetch is best-effort — a NONZERO exit leaves the head unknown for
  // phase 2 to decide (a locally-present ref still baselines; a missing
  // one goes stale on its turn). A THROW in either phase is a wholesale
  // run failure (CR-2): nothing executes, every planned pr is recorded
  // `failed` with the error, and the total report returns immediately.
  // Phase 2 validates each fetched head: the executor's first observation
  // stands in for "the sha the plan was built on" (the plan carries no
  // shas; it was built moments before on the same live state), and null
  // marks a head unresolvable even AFTER its fetch — genuine absence (the
  // pr was merged or closed upstream and its ref reaped) — stale on its
  // turn without any further calls.
  // Run-scoped wholesale failure (round 2, finding 4): the MESSAGE names
  // the sweep, the phase, and the pr it aborted on — every planned pr
  // still gets its own failed record (totality), all quoting the same run
  // cause.
  const failBaselineWholesale = (effect: string, firstPr: number, why: string): ExecutionReport => {
    for (const plannedEntry of plan.order) {
      report.failed.push({
        pr: plannedEntry.pr,
        error: `baseline sweep aborted during ${effect} (first failure at pr ${String(firstPr)}): ${why}`,
      });
    }
    return report;
  };
  const baseline = new Map<number, string | null>();
  for (const entry of plan.order) {
    try {
      await effects.fetchRef(headRefFor(entry.pr));
    } catch (err) {
      return failBaselineWholesale('fetchRef', entry.pr, errorMessage(err));
    }
  }
  for (const entry of plan.order) {
    let probe: { ok: boolean; sha?: string };
    try {
      probe = await effects.validateRef(headRefFor(entry.pr));
    } catch (err) {
      return failBaselineWholesale('validateRef', entry.pr, errorMessage(err));
    }
    baseline.set(entry.pr, probe.ok && probe.sha !== undefined ? probe.sha : null);
  }

  // The not-merged set: any entry that ended stale or failed (or was
  // blocked) — (c)'s cascade reads it via basePr.
  const withheld = new Set<number>();

  // (e)+(b) THE MERGE, with its bounded retry. Total: never throws — a
  // rejecting mergePr is a `failed` outcome, not an escaped exception.
  const mergeWithRetry = async (pr: number, ref: string, expectedSha: string): Promise<Outcome> => {
    for (let attempt = 0; ; attempt += 1) {
      let result: GhResult;
      try {
        result = await effects.mergePr(pr, { method: 'merge' });
      } catch (err) {
        return { kind: 'failed', error: `mergePr for pr ${pr} threw: ${errorMessage(err)}` };
      }
      if (result.code === 0) {
        return { kind: 'merged' };
      }
      if (!RETRYABLE_MERGE_FAILURE.test(result.stderr) || attempt >= maxRetries) {
        // (e) any other failure — or the retry budget spent — is recorded,
        // never retried.
        return {
          kind: 'failed',
          error: `gh pr merge ${pr} --merge failed (exit ${result.code})${stderrSuffix(result.stderr)}`,
        };
      }
      // (e) revalidation between attempts — FETCH FIRST (round 1): the
      // remote head may have moved without any local ref knowing; a blind
      // retry would merge against the drifted base. A nonzero fetch means
      // the truth is unavailable → failed with the error; a head that
      // moved or vanished after the fetch → stale; a validateRef throw →
      // failed. Never a blind retry.
      let refetched: GhResult;
      try {
        refetched = await effects.fetchRef(ref);
      } catch (err) {
        return {
          kind: 'failed',
          error: `retry-revalidation fetchRef for pr ${pr} threw: ${errorMessage(err)}`,
        };
      }
      if (refetched.code !== 0) {
        return {
          kind: 'failed',
          error: `retry revalidation: fetch ${ref} failed (exit ${refetched.code})${stderrSuffix(refetched.stderr)}`,
        };
      }
      let again: { ok: boolean; sha?: string };
      try {
        again = await effects.validateRef(ref);
      } catch (err) {
        return { kind: 'failed', error: `revalidation for pr ${pr} threw: ${errorMessage(err)}` };
      }
      if (!again.ok || again.sha === undefined || again.sha !== expectedSha) {
        return {
          kind: 'stale',
          detail: `head moved while revalidating pr ${pr} before a retry (expected ${expectedSha})`,
        };
      }
    }
  };

  // THE RETARGET-SELF REALIZATION (CR1): the plan carries no branch names,
  // but it does carry the target — a retarget-self entry is a root-position
  // PR whose rung closed, so its new base IS the plan's baseBranch. The
  // whole action is the forge base edit (`retargetBase`): forge metadata,
  // so it never prepares a worktree, never pushes a ref (the read-only
  // refs/pull/<n>/head is unpushable — the old push-based shape is the CR1
  // regression, pinned by test), and never merges (I3). After a successful
  // retarget the PR re-enters the NEXT plan as an ordinary root (F2's
  // contract). Retargeted entries are NOT withheld: their descendants are
  // plan-ordered merges and proceed (only stale/failed ancestors block —
  // rule c). Attempted once, never retried (rule e's budget is scoped to
  // merge failures). The PR head's drift guard ran before dispatch (the
  // same fetch+validate as a merge: a stale retarget is skipped, not
  // edited).
  const retargetOnce = async (pr: number, newBase: string): Promise<Outcome> => {
    let result: GhResult;
    try {
      result = await effects.retargetBase(pr, newBase);
    } catch (err) {
      return { kind: 'failed', error: `retargetBase for pr ${pr} threw: ${errorMessage(err)}` };
    }
    if (result.code === 0) {
      return { kind: 'retargeted' };
    }
    return {
      kind: 'failed',
      error: `gh pr edit ${pr} --base ${newBase} failed (exit ${result.code})${stderrSuffix(result.stderr)}`,
    };
  };

  // File ONE decided outcome into its report bucket (exactly one; merged
  // and retargeted leave the lineage free to proceed).
  const fileOutcome = (pr: number, outcome: Outcome): void => {
    if (outcome.kind === 'merged') {
      report.merged.push(pr); // not withheld — the lineage may proceed
    } else if (outcome.kind === 'retargeted') {
      report.retargeted.push(pr); // not withheld — descendants proceed
    } else if (outcome.kind === 'stale') {
      report.stale.push({ pr, detail: outcome.detail });
      withheld.add(pr);
    } else {
      report.failed.push({ pr, error: outcome.error });
      withheld.add(pr);
    }
  };

  // ONE action, end to end — fetch, revalidate, then the action body: the
  // forge base edit for a retarget-self entry, the server-side
  // bounded-retry merge for a merge entry (neither touches a worktree —
  // round 1).
  const runAction = async (entry: PlannedMergeEntry, expectedSha: string): Promise<void> => {
    const pr = entry.pr;
    const ref = headRefFor(pr);

    // (a) live-state revalidation — truth first (fetch), then validate.
    let fetched: GhResult;
    try {
      fetched = await effects.fetchRef(ref);
    } catch (err) {
      report.failed.push({ pr, error: `fetchRef for pr ${pr} threw: ${errorMessage(err)}` });
      withheld.add(pr);
      return;
    }
    if (fetched.code !== 0) {
      // The head's truth is unavailable — fail closed, touch nothing.
      report.failed.push({
        pr,
        error: `fetch ${ref} failed (exit ${fetched.code})${stderrSuffix(fetched.stderr)}`,
      });
      withheld.add(pr);
      return;
    }
    let live: { ok: boolean; sha?: string };
    try {
      live = await effects.validateRef(ref);
    } catch (err) {
      report.failed.push({ pr, error: `validateRef for pr ${pr} threw: ${errorMessage(err)}` });
      withheld.add(pr);
      return;
    }
    if (!live.ok || live.sha === undefined) {
      report.stale.push({ pr, detail: `head ref ${ref} unresolvable at merge time` });
      withheld.add(pr);
      return;
    }
    if (live.sha !== expectedSha) {
      // Drift between classify/plan and merge — caught here, NOT merged.
      report.stale.push({
        pr,
        detail: `head moved between plan and run (plan saw ${expectedSha}, live is ${live.sha})`,
      });
      withheld.add(pr);
      return;
    }

    // A retarget-self action is FORGE METADATA ONLY (CR1): no worktree, no
    // ref push, no merge — retargetOnce is its whole body.
    if (entry.action === 'retarget-self') {
      fileOutcome(pr, await retargetOnce(pr, plan.baseBranch));
      return;
    }

    // A merge action is SERVER-SIDE ONLY (round 1): gh pr merge needs no
    // tree, so no worktree is prepared or removed here — the bounded-retry
    // merge is the whole body (see rule f in the module doc; worktree
    // lifecycle enters with F4's resolver via withPreparedWorktree).
    // mergeWithRetry is total (never throws), so the outcome files clean.
    fileOutcome(pr, await mergeWithRetry(pr, ref, expectedSha));
  };

  // THE LOOP — plan order, strictly sequential (rule d's determinism), with
  // each action additionally under its effective base's mutex.
  for (const entry of plan.order) {
    // (c) failed ancestor blocks descendants — recorded, never executed.
    if (entry.basePr !== null && withheld.has(entry.basePr)) {
      report.blocked.push({ pr: entry.pr, reason: 'blocked_by_ancestor' });
      withheld.add(entry.pr);
      continue;
    }
    const expectedSha = baseline.get(entry.pr);
    if (expectedSha === undefined || expectedSha === null) {
      // The head was already unresolvable in the baseline sweep — drift
      // between plan and run before anything ran.
      report.stale.push({
        pr: entry.pr,
        detail: 'head ref unresolvable when execution started',
      });
      withheld.add(entry.pr);
      continue;
    }
    await mutexFor(effectiveBaseKey(entry)).run(() => runAction(entry, expectedSha));
  }

  return report;
}
