// Split provenance: test/ops/merge/runPrs.test.ts was split by subject into
// runPrs.basics.test.ts, runPrs.pass2.test.ts, runPrs.dispatch.test.ts,
// runPrs.pass2Safety.test.ts, runPrs.escalation.test.ts,
// runPrs.concurrency.test.ts, runPrs.union.test.ts and runPrs.op.test.ts.
// This module is the single shared-fixture home; it declares no tests.
//
// F4 slice 2 — tests for the merge-prs pipeline composition
// (src/ops/merge/runPrs.ts, ws-f scope item 6).
//
// Pinned here, test by test:
//   1. THE SEAM: the whole pipeline runs through fakes — a recording
//      MergeEffects, a recording resolve op, an injected clock — ZERO real
//      git/gh processes, networks, or filesystems (the one exception, the
//      default-op empty run, points repoRoot at a fresh temp dir and runs
//      an empty plan: no effect call can reach git).
//   2. STAGES, in order: classify (F1) → plan (F2) → execute (F3) →
//      resolve (F4, bounded) → second pass only when something acted →
//      needs-human union + post-mortem of the FINAL report.
//   3. NO RE-GRADING: the conflict set is derived from the F1 verdict, and
//      a second pass re-classifies the candidate set AS IT STANDS — the
//      composition fabricates nothing. With deps.refetch the refreshed set
//      is what pass 2 classifies (the resolution is on the remote; the
//      in-memory candidates are stale); without it, the caller-side flip of
//      the in-memory candidate stands in for the pushed resolution and
//      stays pinned (safe: executeMerges revalidates live state per
//      action).
//   3a. THE PASS-2 CANDIDATE SET FAILS CLOSED: a refetch THROW → no
//       re-plan, secondPass null, every acted pr owed a 'pass-2 refresh
//       failed:' needsHuman row; no acted resolution → the seam is never
//       invoked.
//   4. THE MODEL GATE: conflicts + no modelSpec → needsHuman rows naming
//      modelSpec, resolve NEVER called, no second pass.
//   5. NEVER SILENT: a failed/indeterminate/budget-exhausted resolve
//      verdict escalates with the 'conflict agent did not complete: …'
//      text; only 'acted' earns a second pass.
//   6. BOUNDED CONCURRENCY: p-limit caps observed in-flight resolutions at
//      resolveConcurrency while everything else stays sequential.
//   7. THE UNION: escalations + planner withholds + execution outcomes,
//      pr-sorted, deduped, escalation-priority first reason wins.
//   8. DETERMINISM: same input + same nowMs → deep-equal outcome.
import type { DriverFactory, DriverRequest, ResolvedDriver } from '../../../src/driver/factory.js';
import type { Driver } from '../../../src/driver/types.js';
import type { OpResult } from '../../../src/kernel/types.js';
import { REVIEW_ACCEPT_SETTLE_MS } from '../../../src/ops/merge/classify.config.js';
import type { MergeEffects } from '../../../src/adapters/forge-github/mergeEffects.js';
import type { GhResult } from '../../../src/adapters/forge-github/gh.js';
import type { MergePrsCandidate, RunMergePrsInput } from '../../../src/ops/merge/runPrs.js';
import type {
  ConflictResolutionValue,
  ResolveConflictInput,
} from '../../../src/ops/merge/resolveConflict.js';
import type { ReviewSummary } from '../../../src/ops/review/threads.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OK: GhResult = { code: 0, stdout: '', stderr: '' };
export const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const MODEL_SPEC = { model: 'resolver-model', provider: 'zai' };

/** The candidates' last commit: T0; the injected clock sits exactly AT the
 * settle window (the >= boundary belongs to eligible). */
const LAST_COMMIT = '2026-01-01T00:00:00Z';
const LAST_COMMIT_MS = Date.parse(LAST_COMMIT);
export const NOW_MS = LAST_COMMIT_MS + REVIEW_ACCEPT_SETTLE_MS;
const AFTER_COMMIT = '2026-01-01T00:00:00.500Z';
/** The reviewed head SHA — `eligible()` and `approved()` agree on it so the
 * default fixture is a valid head-bound pair (#1213). */
export const HEAD = 'a'.repeat(40);

/** An acceptable review that is NOT an all-clear: non-author, APPROVED,
 * postdates the last commit (the classifyPrs.helpers.ts fixture body — known
 * not to match the shipped all-clear pattern). */
export const approved = (pr: number): ReviewSummary => ({
  id: `PRR_${String(pr)}`,
  authorLogin: 'alice',
  state: 'APPROVED',
  body: 'approving the cache changes',
  commitOid: HEAD,
  submittedAt: AFTER_COMMIT,
});

/** An OPEN pr that classifies `eligible` (settle window elapsed): clean,
 * reviewed, quiet. Stack position defaults to a root on 'main'. */
export const eligible = (pr: number, extra?: Partial<MergePrsCandidate>): MergePrsCandidate => ({
  pr,
  authorLogin: 'pr-author',
  draft: false,
  mergeState: 'CLEAN',
  truncated: false,
  threads: [],
  reviews: [approved(pr)],
  issueComments: [],
  lastCommitAt: LAST_COMMIT,
  headRefOid: HEAD,
  headRefName: `feat/${String(pr)}`,
  baseRefName: 'main',
  state: 'open',
  ...extra,
});

/** An OPEN pr F1 verdicts `conflicting` (row 2: DIRTY — ahead of every
 * review row, whatever the evidence). */
export const conflicting = (pr: number, extra?: Partial<MergePrsCandidate>): MergePrsCandidate =>
  eligible(pr, { mergeState: 'DIRTY', ...extra });

/** An OPEN pr F1 verdicts `never` (row 1: draft) — the planner withholds
 * it 'not_eligible' without any agent involvement. */
export const draft = (pr: number): MergePrsCandidate => eligible(pr, { draft: true });

/** The base input: trunk 'main', the effects target, the injected clock,
 * and (when given) the conflict-agent binding. */
export const baseInput = (
  prs: MergePrsCandidate[],
  modelSpec?: typeof MODEL_SPEC,
): RunMergePrsInput => ({
  baseBranch: 'main',
  repoRoot: '/repo',
  prs,
  ...(modelSpec !== undefined ? { modelSpec } : {}),
  nowMs: NOW_MS,
});

/**
 * THE FAKE EFFECTS — an in-memory MergeEffects, zero real git/gh. Records
 * every call; scriptable failures: a nonzero fetchRef and per-pr mergePr
 * failures (the union test's failed-merge surface). validateRef answers
 * the same sha EXCEPT for refs listed in driftRefs, which drift after
 * their first validate (the plan→run drift-stale surface), and EXCEPT for
 * the merge family's worktree branches (`refs/heads/cq-merge/pr-<n>` —
 * issue #1193), where the publication gate's single read answers
 * `resolutionSha` (default MOVED off the baseline; null = unresolvable).
 */
export class FakeMergeEffects implements MergeEffects {
  readonly calls: string[] = [];
  /** pr → forge base ref (what readBaseRef answers); absent → 'main'. */
  readonly baseRefs = new Map<number, string>();
  fetchCode = 0;
  fetchStderr = '';
  readonly mergeFailures = new Set<number>();
  /** Prs whose FIRST mergePr fails and later ones succeed — the pass-2
   * retry scripting hook (a pass-1 failure that pass 2 can recover). */
  readonly mergeFailOnce = new Set<number>();
  /** retarget-self prs whose retargetBase fails — the failed-retarget
   * scripting hook (a failed retarget withholds the pr, and the executor
   * then blocks its plan-ordered descendants). */
  readonly retargetFailures = new Set<number>();
  /** Refs whose head MOVES between the baseline validate (call 1) and any
   * later validate — the plan→run drift-stale scripting hook. */
  readonly driftRefs = new Set<string>();
  /** The sha the publication gate reads on a prepared worktree's branch
   * (issue #1193); null = unresolvable. Default MOVED off the baseline. */
  resolutionSha: string | null = 'c'.repeat(40);
  private validateCounts = new Map<string, number>();
  private mergeCallCounts = new Map<number, number>();

  async validateRef(ref: string): Promise<{ ok: boolean; sha?: string }> {
    this.calls.push(`validate:${ref}`);
    if (ref.startsWith('refs/heads/cq-merge/')) {
      return this.resolutionSha === null ? { ok: false } : { ok: true, sha: this.resolutionSha };
    }
    const count = (this.validateCounts.get(ref) ?? 0) + 1;
    this.validateCounts.set(ref, count);
    if (this.driftRefs.has(ref) && count > 1) return { ok: true, sha: 'd'.repeat(40) };
    return { ok: true, sha: 'b'.repeat(40) };
  }

  async fetchRef(ref: string): Promise<GhResult> {
    this.calls.push(`fetch:${ref}`);
    return { code: this.fetchCode, stdout: '', stderr: this.fetchStderr };
  }

  async readBaseRef(pr: number): Promise<{ ok: boolean; baseRefName?: string }> {
    this.calls.push(`readBase:${String(pr)}`);
    // Every executing merge in these scenarios is a root on the trunk; a
    // stacked child that would name another base is always withheld or
    // planned retarget-self (which never reads). A future stacked-merge
    // scenario seeds baseRefs rather than silently going stale.
    return { ok: true, baseRefName: this.baseRefs.get(pr) ?? 'main' };
  }

  async worktreePrepare(pr: number, ref: string): Promise<{ path: string }> {
    this.calls.push(`prepare:${String(pr)}@${ref}`);
    return { path: `/wt/pr-${String(pr)}` };
  }

  async worktreeRemove(path: string): Promise<void> {
    this.calls.push(`remove:${path}`);
  }

  async mergePr(pr: number, opts: { method: 'merge' }): Promise<GhResult> {
    this.calls.push(`merge:${String(pr)}:${opts.method}`);
    const mergeCall = (this.mergeCallCounts.get(pr) ?? 0) + 1;
    this.mergeCallCounts.set(pr, mergeCall);
    if (this.mergeFailures.has(pr) || (this.mergeFailOnce.has(pr) && mergeCall === 1)) {
      return { code: 1, stdout: '', stderr: 'refused by the forge' };
    }
    return OK;
  }

  async retargetBase(pr: number, newBase: string): Promise<GhResult> {
    this.calls.push(`retarget:${String(pr)}:base=${newBase}`);
    if (this.retargetFailures.has(pr)) {
      return { code: 1, stdout: '', stderr: 'refused by the forge' };
    }
    return OK;
  }

  async diffPatch(from: string, to: string): Promise<GhResult> {
    this.calls.push(`diff:${from}..${to}`);
    return OK;
  }
  async commitParents(): Promise<{ ok: boolean; parents?: string[] }> {
    // The valid topology the publication gate expects (review P1 round 2):
    // exactly one parent, and that parent is the baseline validateRef
    // answers with — a resolution stacked directly on the prepared head.
    return { ok: true, parents: ['b'.repeat(40)] };
  }
  async isAncestor(): Promise<GhResult> {
    return { code: 1, stdout: '', stderr: '' };
  }
  async readCommitMessage(): Promise<GhResult> {
    return { code: 0, stdout: 'resolve\n', stderr: '' };
  }

  async readCommitEncoding(): Promise<GhResult> {
    return { code: 0, stdout: '', stderr: '' };
  }

  async objectExists(): Promise<GhResult> {
    return { code: 0, stdout: '', stderr: '' };
  }

  async fetchBaseBranch(): Promise<GhResult> {
    return { code: 0, stdout: '', stderr: '' };
  }
  async pushRef(ref: string, fromPath: string): Promise<GhResult> {
    this.calls.push(`push:${ref}@${fromPath}`);
    return OK;
  }
}

/** The resolve results a scenario needs, as frozen OpResults. */
export const acted = (
  pr: number,
  summary = 'pushed the resolution',
): OpResult<ConflictResolutionValue> => ({
  status: 'ok',
  value: { pr, decision: 'acted', summary },
});
export const escalated = (summary: string): OpResult<ConflictResolutionValue> => ({
  status: 'needs-human',
  reason: summary,
});
export const resolveFailed = (error: string): OpResult<ConflictResolutionValue> => ({
  status: 'failed',
  error,
});

/**
 * THE FAKE RESOLVE — records every ResolveConflictInput it was called
 * with and answers with a scripted OpResult. A `before` hook runs before
 * the scripted result returns: the second-pass test uses it to flip the
 * candidate's mergeState, standing in for the real agent's pushed
 * resolution changing what the next classification sees.
 */
export const fakeResolve = (
  scripted: OpResult<ConflictResolutionValue>,
  before?: (input: ResolveConflictInput) => void,
): {
  resolve: (input: ResolveConflictInput) => Promise<OpResult<ConflictResolutionValue>>;
  calls: ResolveConflictInput[];
} => {
  const calls: ResolveConflictInput[] = [];
  const resolve = async (
    input: ResolveConflictInput,
  ): Promise<OpResult<ConflictResolutionValue>> => {
    calls.push(input);
    before?.(input);
    return scripted;
  };
  return { resolve, calls };
};

/**
 * THE FAKE REFETCH — the pass-2 live-refresh seam: records every
 * invocation and answers with a scripted candidate set (or throws — the
 * fail-closed surface). The scripted set is the refreshed forge view; a
 * formerly-conflicting pr arrives CLEAN, and merged/closed prs may be
 * omitted entirely.
 */
export const fakeRefetch = (
  scripted: MergePrsCandidate[] | Error,
): { refetch: () => Promise<MergePrsCandidate[]>; callCount: () => number } => {
  let calls = 0;
  const refetch = async (): Promise<MergePrsCandidate[]> => {
    calls += 1;
    if (scripted instanceof Error) throw scripted;
    return scripted;
  };
  return { refetch, callCount: () => calls };
};

/**
 * THE FAKE DRIVER FACTORY — records every DriverRequest and resolves to
 * the given driver verbatim (the served-model wrapper is the real
 * factory's concern; factory tests own it).
 */
export const fakeDrivers = (
  driver: Driver,
): DriverFactory & {
  requests: DriverRequest[];
  resolve(request: DriverRequest): ResolvedDriver;
} => {
  const requests: DriverRequest[] = [];
  return {
    requests,
    resolve: (request: DriverRequest): ResolvedDriver => {
      requests.push(request);
      return { driver, lane: 'ai-sdk', modelSpec: request.modelSpec };
    },
  };
};
