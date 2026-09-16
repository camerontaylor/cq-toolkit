// executeMerges — the F2 plan's executor (goal F3, ws-f scope item 3;
// UC §3 row 43). The plan is the ONLY source of actions: exactly the
// entries in `plan.order` are acted on — 'merge' entries merge, 'retarget-
// self' entries push their head ref — and `plan.needsHuman` entries are
// NEVER executed (I2 carries through execution: a PR a human owes is not
// merged by a machine). The executor is pure orchestration: every git/gh
// mutation rides the injected MergeEffects seam (see ./effects.js — UC row
// 43's load-bearing point: the whole flow is testable with ZERO real
// git/gh), so this module contains no transport, no spawning, no fs.
//
// THE SEMANTICS, each pinned by a test:
//   a. LIVE-STATE REVALIDATION per action — before merging PR N, its head
//      ref (refs/pull/<n>/head, the PR-number-addressable truth) is fetched
//      fresh and validated against the BASELINE: the executor's first
//      observation of each planned head, taken in one sweep before any
//      action runs (the observable stand-in for "the sha the plan was
//      built on" — the executor is invoked directly after planning on the
//      same live state, and the plan itself carries no shas). A head that
//      moved between the baseline and the merge — or vanished — is drift
//      between classify/plan and merge: the action is SKIPPED as `stale`,
//      never merged, the reason recorded.
//   b. MERGE COMMITS ONLY (I3) — mergePr is called with method 'merge'
//      exclusively; the production effects route every argv through
//      safeArgs (./effects.js), which throws on squash/force/rebase/hard/
//      push-to-main before any process exists.
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
//      head revalidated between attempts (a head that moved mid-retry
//      turns the action stale, never a blind retry). ANY other failure is
//      recorded `failed` immediately and NOT retried.
//   f. WORKTREES REMOVED IN FINALLY — every worktreePrepare is paired with
//      a worktreeRemove in a try/finally: the removal happens even when
//      the merge fails. A removal failure never masks the primary outcome:
//      it is appended to the record when the record carries a detail/error
//      field, and dropped when the outcome is a clean merge/retarget (the
//      merge truth stands; a wedged tree surfaces loudly at the next run's
//      worktree add — never as a rewritten report bucket).
//
// TOTALITY: every PR in plan.order lands in EXACTLY ONE of merged /
// retargeted / stale / failed / blocked. Effect methods that REJECT
// (a misbehaving fake, a spawn-level throw) are caught and recorded as
// `failed` — the report is total by construction, not by optimism. (The
// planner's duplicate_pr gate guarantees one entry per pr; executeMerges
// relies on that and does not re-guard.)
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
  /** retarget-self entries whose head ref was pushed, in execution order. */
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
  const report: ExecutionReport = { merged: [], retargeted: [], stale: [], failed: [], blocked: [] };

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

  // (a) THE BASELINE SWEEP: one validateRef per planned head BEFORE any
  // action runs — the executor's first observation stands in for "the sha
  // the plan was built on" (the plan carries no shas; it was built moments
  // before on the same live state). null marks a head already unresolvable
  // at start: such an entry is stale on its turn without any further calls.
  const baseline = new Map<number, string | null>();
  for (const entry of plan.order) {
    const probe = await effects.validateRef(headRefFor(entry.pr));
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
      // (e) revalidation between attempts: a head that moved or vanished
      // mid-retry turns the action stale — never a blind retry.
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

  // THE RETARGET-SELF REALIZATION: the plan carries no branch names, so the
  // executor owns exactly one ref per PR — its head ref. The action
  // revalidates the head (the same drift guard as a merge: a stale retarget
  // is skipped, not pushed), prepares a worktree at the head ref, and
  // pushRef's the head ref from there — the ref-level half of retargeting,
  // after which the PR re-enters the NEXT plan as an ordinary root (F2's
  // contract). The gh-side base-pointer edit is deliberately NOT in this
  // seam: the base is forge metadata, not a git ref, and I3 keeps this
  // executor to ref and merge-commits-only mutations. Retargeted entries
  // are NOT withheld: their descendants are plan-ordered merges and
  // proceed (only stale/failed ancestors block — rule c). Attempted once,
  // never retried (rule e's budget is scoped to merge failures).
  const retargetOnce = async (pr: number, ref: string, fromPath: string): Promise<Outcome> => {
    let result: GhResult;
    try {
      result = await effects.pushRef(ref, fromPath);
    } catch (err) {
      return { kind: 'failed', error: `pushRef for pr ${pr} threw: ${errorMessage(err)}` };
    }
    if (result.code === 0) {
      return { kind: 'retargeted' };
    }
    return {
      kind: 'failed',
      error: `pushRef ${ref} for pr ${pr} failed (exit ${result.code})${stderrSuffix(result.stderr)}`,
    };
  };

  // ONE action, end to end — fetch, revalidate, prepare, act, remove.
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

    let prepared: { path: string };
    try {
      prepared = await effects.worktreePrepare(pr, ref);
    } catch (err) {
      report.failed.push({
        pr,
        error: `worktreePrepare for pr ${pr} failed: ${errorMessage(err)}`,
      });
      withheld.add(pr);
      return;
    }

    // (f) the act/remove pairing: whatever the action decides, the worktree
    // goes — and a cleanup failure never masks the primary outcome.
    let outcome: Outcome | undefined;
    try {
      outcome =
        entry.action === 'merge'
          ? await mergeWithRetry(pr, ref, expectedSha)
          : await retargetOnce(pr, ref, prepared.path);
    } catch (err) {
      outcome = { kind: 'failed', error: `action for pr ${pr} threw: ${errorMessage(err)}` };
    } finally {
      let removalNote = '';
      try {
        await effects.worktreeRemove(prepared.path);
      } catch (err) {
        removalNote = `; worktreeRemove ${prepared.path} also failed: ${errorMessage(err)}`;
      }
      if (removalNote !== '' && outcome !== undefined) {
        if (outcome.kind === 'stale') {
          outcome = { kind: 'stale', detail: `${outcome.detail}${removalNote}` };
        } else if (outcome.kind === 'failed') {
          outcome = { kind: 'failed', error: `${outcome.error}${removalNote}` };
        }
        // merged/retargeted: the clean outcome stands (module doc, rule f).
      }
    }

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
