// Shared fixtures for the executeMerges.*.test.ts split files (moved from
// test/ops/merge/executeMerges.test.ts, F3). Not a *.test.ts file, so
// vitest never collects it.

import type { GhResult } from '../../../src/adapters/forge-github/gh.js';
import type { MergeEffects } from '../../../src/adapters/forge-github/mergeEffects.js';
import { planMergeOrder } from '../../../src/ops/merge/planMergeOrder.js';
import type {
  PlanBlockReason,
  PlanMergeResult,
  PlannedMergeEntry,
  PlannedPr,
} from '../../../src/ops/merge/planMergeOrder.js';
import type { PrClassification } from '../../../src/ops/merge/classifyPrs.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const OK: GhResult = { code: 0, stdout: '', stderr: '' };

/** F1's happy verdict (the classification an ordinary eligible PR carries). */
export const ELIGIBLE: PrClassification = {
  verdict: 'eligible',
  reason: 'settle_window_elapsed',
  unresolvedExternalThreads: 0,
};

/** An open, classified, untruncated PR — every planning gate open. */
export const planned = (pr: number, baseRefName: string, headRefName: string): PlannedPr => ({
  pr,
  headRefName,
  baseRefName,
  state: 'open',
  authorLogin: null,
  classification: ELIGIBLE,
  truncated: false,
});

/** A real F2 plan (provenance: plan → execute, end to end). */
export const stackPlan = (prs: PlannedPr[], baseBranch = 'main'): PlanMergeResult =>
  planMergeOrder({ baseBranch, prs });

/** A hand-built plan entry (for shapes the planner's fixtures don't cover,
 * e.g. retarget-self and needsHuman rows). */
export const entry = (
  pr: number,
  action: 'merge' | 'retarget-self' = 'merge',
  basePr: number | null = null,
  depth = 0,
  baseRefName?: string,
): PlannedMergeEntry => ({
  pr,
  action,
  basePr,
  depth,
  ...(baseRefName !== undefined ? { baseRefName } : {}),
});

export const handPlan = (
  order: PlannedMergeEntry[],
  needsHuman: Array<{ pr: number; reason: PlanBlockReason }> = [],
  baseBranch = 'main',
): PlanMergeResult => ({ order, needsHuman, baseBranch });

/** A hand-built root+child stack — the shape planMergeOrder emitted before
 * review-debt #153 deferred same-pass merge-root children. The executor
 * takes its plan as gospel, so the dependency-order and cascade semantics
 * stay pinned against the shape a caller can still hand it. */
export const rootChildPlan = (
  root: number,
  child: number,
  childBaseRef: string,
  baseBranch = 'main',
): PlanMergeResult =>
  handPlan([entry(root), entry(child, 'merge', root, 1, childBaseRef)], [], baseBranch);

export const sha = (seed: string): string => seed.repeat(40);

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
export class FakeMergeEffects implements MergeEffects {
  /** Every effect call, in order: `validate:<ref>`, `fetch:<ref>`,
   * `readBase:<pr>`, `prepare:<pr>@<ref>`, `merge:<pr>:<method>`,
   * `retarget:<pr>:base=<newBase>`, `push:<ref>@<path>`, `remove:<path>`. */
  readonly calls: string[] = [];
  /** pr → live head sha (what validateRef answers). */
  readonly heads = new Map<number, string>();
  /** pr → forge base ref (what readBaseRef answers); absent → 'main'. */
  readonly baseRefs = new Map<number, string>();
  /** pr → readBaseRef fails (`{ ok: false }`). */
  readonly baseReadFailures = new Set<number>();
  /** readBaseRef call count per pr — the base-drift scripting hook. */
  readonly baseReadCalls = new Map<number, number>();
  /** When set, every readBaseRef call for a pr AT/AFTER baseDriftFromCall
   * (0-based) answers baseDriftRef instead of the baseRefs entry — the
   * between-attempts retarget. Default null (no drift). */
  baseDriftRef: string | null = null;
  baseDriftFromCall = 1;
  /** When true, readBaseRef answers `{ ok: true, baseRefName: <number> }` —
   * the misbehaving-seam hook (the executor must not trust the seam type). */
  baseReadNonString = false;
  /** When set, readBaseRef THROWS with this error — the rejecting-read
   * scripting hook. */
  baseReadThrows: Error | null = null;
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

  async readBaseRef(pr: number): Promise<{ ok: boolean; baseRefName?: string }> {
    this.calls.push(`readBase:${String(pr)}`);
    if (this.baseReadThrows !== null) throw this.baseReadThrows;
    if (this.baseReadFailures.has(pr)) return { ok: false };
    if (this.baseReadNonString) return { ok: true, baseRefName: 42 as unknown as string };
    const seen = this.baseReadCalls.get(pr) ?? 0;
    this.baseReadCalls.set(pr, seen + 1);
    if (this.baseDriftRef !== null && seen >= this.baseDriftFromCall) {
      return { ok: true, baseRefName: this.baseDriftRef };
    }
    return { ok: true, baseRefName: this.baseRefs.get(pr) ?? 'main' };
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

  async diffPatch(from: string, to: string): Promise<GhResult> {
    this.calls.push(`diff:${from}..${to}`);
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

export const mergeCalls = (fake: FakeMergeEffects): string[] =>
  fake.calls.filter((call) => call.startsWith('merge:'));
