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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import type { OpResult } from '../../../src/kernel/types.js';
import { REVIEW_ACCEPT_SETTLE_MS } from '../../../src/ops/merge/classify.config.js';
import type { MergeEffects } from '../../../src/ops/merge/effects.js';
import type { GhResult } from '../../../src/ops/review/gh.js';
import {
  makeRunMergePrsOp,
  MODEL_SPEC_REQUIRED_REASON,
  runMergePrs,
} from '../../../src/ops/merge/runPrs.js';
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
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const MODEL_SPEC = { model: 'resolver-model', provider: 'zai' };

/** The candidates' last commit: T0; the injected clock sits exactly AT the
 * settle window (the >= boundary belongs to eligible). */
const LAST_COMMIT = '2026-01-01T00:00:00Z';
const LAST_COMMIT_MS = Date.parse(LAST_COMMIT);
const NOW_MS = LAST_COMMIT_MS + REVIEW_ACCEPT_SETTLE_MS;
const AFTER_COMMIT = '2026-01-01T00:00:00.500Z';

/** An acceptable review that is NOT an all-clear: non-author, APPROVED,
 * postdates the last commit (the classifyPrs.test.ts fixture body — known
 * not to match the shipped all-clear pattern). */
const approved = (pr: number): ReviewSummary => ({
  id: `PRR_${String(pr)}`,
  authorLogin: 'alice',
  state: 'APPROVED',
  body: 'approving the cache changes',
  submittedAt: AFTER_COMMIT,
});

/** An OPEN pr that classifies `eligible` (settle window elapsed): clean,
 * reviewed, quiet. Stack position defaults to a root on 'main'. */
const eligible = (pr: number, extra?: Partial<MergePrsCandidate>): MergePrsCandidate => ({
  pr,
  authorLogin: 'pr-author',
  draft: false,
  mergeState: 'CLEAN',
  truncated: false,
  threads: [],
  reviews: [approved(pr)],
  issueComments: [],
  lastCommitAt: LAST_COMMIT,
  headRefName: `feat/${String(pr)}`,
  baseRefName: 'main',
  state: 'open',
  ...extra,
});

/** An OPEN pr F1 verdicts `conflicting` (row 2: DIRTY — ahead of every
 * review row, whatever the evidence). */
const conflicting = (pr: number, extra?: Partial<MergePrsCandidate>): MergePrsCandidate =>
  eligible(pr, { mergeState: 'DIRTY', ...extra });

/** An OPEN pr F1 verdicts `never` (row 1: draft) — the planner withholds
 * it 'not_eligible' without any agent involvement. */
const draft = (pr: number): MergePrsCandidate => eligible(pr, { draft: true });

/** The base input: trunk 'main', the effects target, the injected clock,
 * and (when given) the conflict-agent binding. */
const baseInput = (prs: MergePrsCandidate[], modelSpec?: typeof MODEL_SPEC): RunMergePrsInput => ({
  baseBranch: 'main',
  repoRoot: '/repo',
  prs,
  ...(modelSpec !== undefined ? { modelSpec } : {}),
  nowMs: NOW_MS,
});

/**
 * THE FAKE EFFECTS — an in-memory MergeEffects, zero real git/gh. Records
 * every call; scriptable failures: a nonzero fetchRef and per-pr mergePr
 * failures (the union test's failed-merge surface). validateRef always
 * answers the same sha, so no drift ever fires.
 */
class FakeMergeEffects implements MergeEffects {
  readonly calls: string[] = [];
  fetchCode = 0;
  fetchStderr = '';
  readonly mergeFailures = new Set<number>();

  async validateRef(ref: string): Promise<{ ok: boolean; sha?: string }> {
    this.calls.push(`validate:${ref}`);
    return { ok: true, sha: 'b'.repeat(40) };
  }

  async fetchRef(ref: string): Promise<GhResult> {
    this.calls.push(`fetch:${ref}`);
    return { code: this.fetchCode, stdout: '', stderr: this.fetchStderr };
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
    if (this.mergeFailures.has(pr)) {
      return { code: 1, stdout: '', stderr: 'refused by the forge' };
    }
    return OK;
  }

  async retargetBase(pr: number, newBase: string): Promise<GhResult> {
    this.calls.push(`retarget:${String(pr)}:base=${newBase}`);
    return OK;
  }

  async pushRef(ref: string, fromPath: string): Promise<GhResult> {
    this.calls.push(`push:${ref}@${fromPath}`);
    return OK;
  }
}

/** The resolve results a scenario needs, as frozen OpResults. */
const acted = (
  pr: number,
  summary = 'pushed the resolution',
): OpResult<ConflictResolutionValue> => ({
  status: 'ok',
  value: { pr, decision: 'acted', summary },
});
const escalated = (summary: string): OpResult<ConflictResolutionValue> => ({
  status: 'needs-human',
  reason: summary,
});
const resolveFailed = (error: string): OpResult<ConflictResolutionValue> => ({
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
const fakeResolve = (
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
const fakeRefetch = (
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

// ---------------------------------------------------------------------------
// The pipeline, stage by stage
// ---------------------------------------------------------------------------

describe('runMergePrs', () => {
  test('happy path, no conflicts: both eligible prs merge in pass 1; the agent never runs', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(acted(999));
    const outcome = await runMergePrs(baseInput([eligible(44), eligible(45)]), {
      effects,
      resolve,
    });

    expect(outcome.firstPass.merged).toEqual([44, 45]);
    expect(outcome.secondPass).toBeNull();
    expect(outcome.resolutions).toEqual([]);
    expect(outcome.needsHuman).toEqual([]);
    // The post-mortem of the final (= first) report: nothing to do.
    expect(outcome.diagnosis.needsHuman).toEqual([]);
    expect(outcome.diagnosis.causes).toEqual([]);
    // The agent is never dispatched when nothing conflicts.
    expect(calls).toEqual([]);
  });

  test('no acted resolution: the pass-2 refresh seam is never invoked even when wired', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(acted(999));
    const { refetch, callCount } = fakeRefetch([]);
    const outcome = await runMergePrs(baseInput([eligible(44), eligible(45)]), {
      effects,
      resolve,
      refetch,
    });

    expect(outcome.firstPass.merged).toEqual([44, 45]);
    expect(outcome.secondPass).toBeNull();
    expect(outcome.resolutions).toEqual([]);
    expect(outcome.needsHuman).toEqual([]);
    // The post-mortem of the final (= first) report: nothing to do.
    expect(outcome.diagnosis.needsHuman).toEqual([]);
    expect(outcome.diagnosis.causes).toEqual([]);
    // The agent is never dispatched when nothing conflicts.
    expect(calls).toEqual([]);
    // And with no acted resolution the pass-2 refresh seam is never paid.
    expect(callCount()).toBe(0);
  });

  test('conflict → acted, NO refetch seam: pass 2 runs on the in-memory candidates', async () => {
    const candidates = [eligible(44), conflicting(45)];
    const effects = new FakeMergeEffects();
    // No refetch seam: pass 2 classifies the IN-MEMORY candidates, so the
    // caller-side flip of the candidate stands in for the pushed
    // resolution changing reality. Safe, never unsound: executeMerges
    // revalidates live state per action, so stale candidates can only
    // produce skipped-with-reason outcomes — this test pins the in-memory
    // path (the seam path is the next test).
    const { resolve, calls } = fakeResolve(acted(45, 'union merge pushed'), (input) => {
      const target = candidates.find((candidate) => candidate.pr === input.pr);
      if (target !== undefined) target.mergeState = 'CLEAN';
    });

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), { effects, resolve });

    // Pass 1: only the eligible pr merges; the conflicting one is withheld
    // (consistent with the planner's 'not_eligible' for a DIRTY pr).
    expect(outcome.firstPass.merged).toEqual([44]);
    // The agent was dispatched on exactly the conflicting pr, with the
    // composed input (stack branch names + modelSpec; passthroughs absent
    // when the input omits them).
    expect(calls).toEqual([
      {
        pr: 45,
        repoRoot: '/repo',
        headBranch: 'feat/45',
        baseBranch: 'main',
        modelSpec: MODEL_SPEC,
      },
    ]);
    expect(outcome.resolutions).toEqual([
      { pr: 45, decision: 'acted', summary: 'union merge pushed' },
    ]);
    // Pass 2 ran, re-planned, and the formerly-conflicting pr MERGED there.
    expect(outcome.secondPass).not.toBeNull();
    expect(outcome.secondPass?.merged).toContain(45);
    expect(outcome.needsHuman).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('no-refetch pass 2 EXCLUDES pass-1 merged prs: 44 never re-merged, 45 still processes', async () => {
    const candidates = [eligible(44), conflicting(45)];
    const effects = new FakeMergeEffects();
    const { resolve } = fakeResolve(acted(45, 'union merge pushed'), (input) => {
      const target = candidates.find((candidate) => candidate.pr === input.pr);
      if (target !== undefined) target.mergeState = 'CLEAN';
    });

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), { effects, resolve });

    // mergePr(44) EXACTLY once — pass 1 only. A server-side merge does not
    // delete refs/pull/44/head, so an unguarded pass 2 would re-attempt it
    // (per-action revalidation cannot withhold a merged pr) and fail it
    // into a false needsHuman row.
    const mergeCalls = effects.calls.filter((call) => call.startsWith('merge:'));
    expect(mergeCalls).toEqual(['merge:44:merge', 'merge:45:merge']);
    // Pass 2 processed ONLY the flipped pr: 45 merges there; 44 — merged
    // in pass 1 — is excluded from the pass-2 report entirely.
    expect(outcome.firstPass.merged).toEqual([44]);
    expect(outcome.secondPass?.merged).toEqual([45]);
    expect(outcome.needsHuman).toEqual([]);
  });

  test('refetch pass 2 also EXCLUDES pass-1 merged prs (a racing fetch cannot resurrect one)', async () => {
    const effects = new FakeMergeEffects();
    const { resolve } = fakeResolve(acted(45, 'union merge pushed'));
    // The refreshed set still lists pr 44 — as if the fetch raced the
    // server-side merge: the exclusion must filter it anyway.
    const { refetch } = fakeRefetch([eligible(44), eligible(45)]);

    const outcome = await runMergePrs(baseInput([eligible(44), conflicting(45)], MODEL_SPEC), {
      effects,
      resolve,
      refetch,
    });

    const mergeCalls = effects.calls.filter((call) => call.startsWith('merge:'));
    expect(mergeCalls).toEqual(['merge:44:merge', 'merge:45:merge']);
    expect(outcome.firstPass.merged).toEqual([44]);
    expect(outcome.secondPass?.merged).toEqual([45]);
    expect(outcome.needsHuman).toEqual([]);
  });

  test('conflict → acted WITH refetch: pass 2 classifies the REFRESHED set and merges there', async () => {
    const effects = new FakeMergeEffects();
    // The resolve fake does NOT touch the candidates: the in-memory
    // snapshot stays stale (still DIRTY) exactly as it would in production
    // — the pushed resolution lives on the remote.
    const { resolve } = fakeResolve(acted(45, 'union merge pushed'));
    // The refreshed forge view: the formerly-DIRTY pr arrives CLEAN (and a
    // merged/closed pr could be omitted entirely — same shape, fewer rows).
    const { refetch, callCount } = fakeRefetch([eligible(44), eligible(45)]);

    const outcome = await runMergePrs(baseInput([eligible(44), conflicting(45)], MODEL_SPEC), {
      effects,
      resolve,
      refetch,
    });

    // Pass 1: only the eligible pr merges; the conflicting one is withheld.
    expect(outcome.firstPass.merged).toEqual([44]);
    expect(outcome.resolutions).toEqual([
      { pr: 45, decision: 'acted', summary: 'union merge pushed' },
    ]);
    // The seam earned its keep: invoked exactly once, and pass 2 — planned
    // from the REFRESHED set — merges the formerly-conflicting pr.
    expect(callCount()).toBe(1);
    expect(outcome.secondPass).not.toBeNull();
    expect(outcome.secondPass?.merged).toContain(45);
    expect(outcome.needsHuman).toEqual([]);
  });

  test('the resolve input carries the CANDIDATE base: stacked vs root', async () => {
    const effects = new FakeMergeEffects();
    // pr 43: root on 'main' (its head is the stack's parent branch);
    // pr 45: stacked ON that parent branch — its conflict is against
    // 'b-parent', not the trunk; pr 46: an ordinary conflicting root.
    const candidates = [
      eligible(43, { headRefName: 'b-parent' }),
      conflicting(45, { baseRefName: 'b-parent' }),
      conflicting(46),
    ];
    const calls: ResolveConflictInput[] = [];
    const resolve = async (
      input: ResolveConflictInput,
    ): Promise<OpResult<ConflictResolutionValue>> => {
      calls.push(input);
      return acted(input.pr, `pushed ${String(input.pr)}`);
    };

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), { effects, resolve });

    // The dispatch base is each candidate's OWN baseRefName: the stacked
    // pr resolves against 'b-parent' (its parent's head branch), the root
    // against input.baseBranch ('main' — a root's baseRefName IS the base
    // branch, so roots are unchanged by the candidate-base rule).
    expect(calls.map((call) => ({ pr: call.pr, baseBranch: call.baseBranch }))).toEqual([
      { pr: 45, baseBranch: 'b-parent' },
      { pr: 46, baseBranch: 'main' },
    ]);
    expect(calls[0]).toEqual({
      pr: 45,
      repoRoot: '/repo',
      headBranch: 'feat/45',
      baseBranch: 'b-parent',
      modelSpec: MODEL_SPEC,
    });
    expect(outcome.resolutions).toEqual([
      { pr: 45, decision: 'acted', summary: 'pushed 45' },
      { pr: 46, decision: 'acted', summary: 'pushed 46' },
    ]);
    // Pass 1 merged the eligible parent; pass 2 (guarded) excluded it and
    // the two unflipped conflicts re-withheld — the honest no-refetch
    // outcome for a claimed-but-unobserved flip.
    expect(outcome.firstPass.merged).toEqual([43]);
    expect(outcome.secondPass?.merged).toEqual([]);
    expect(outcome.needsHuman).toEqual([
      { pr: 45, reason: 'not_eligible' },
      { pr: 46, reason: 'not_eligible' },
    ]);
  });

  test('refetch THROW fails closed: no re-plan, secondPass null, every acted pr owed a row', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(acted(46, 'pushed 46'));
    // Two acted prs: the failure rows must name EVERY one of them.
    const { resolve: resolveSecond, calls: callsSecond } = fakeResolve(acted(47, 'pushed 47'));
    const bothResolve = async (
      input: ResolveConflictInput,
    ): Promise<OpResult<ConflictResolutionValue>> =>
      input.pr === 46 ? resolve(input) : resolveSecond(input);
    const { refetch, callCount } = fakeRefetch(new Error('forge unreachable'));

    const outcome = await runMergePrs(baseInput([conflicting(46), conflicting(47)], MODEL_SPEC), {
      effects,
      resolve: bothResolve,
      refetch,
    });

    // The resolutions happened and stay recorded as acted.
    expect(outcome.resolutions).toEqual([
      { pr: 46, decision: 'acted', summary: 'pushed 46' },
      { pr: 47, decision: 'acted', summary: 'pushed 47' },
    ]);
    // Fail closed: the seam was tried, pass 2 never ran.
    expect(callCount()).toBe(1);
    expect(outcome.secondPass).toBeNull();
    // Every acted pr is owed a row naming the refresh failure — the
    // resolution happened but re-entry is unproven, never a silent success.
    expect(outcome.needsHuman).toEqual([
      { pr: 46, reason: 'pass-2 refresh failed: forge unreachable' },
      { pr: 47, reason: 'pass-2 refresh failed: forge unreachable' },
    ]);
    expect(outcome.firstPass.merged).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(callsSecond).toHaveLength(1);
  });

  test('resolve passthroughs (protectedBranch/wallClockMs/sessionsDir) ride the resolve input', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(acted(45));
    const outcome = await runMergePrs(
      {
        ...baseInput([conflicting(45)], MODEL_SPEC),
        protectedBranch: 'trunk',
        wallClockMs: 1234,
        sessionsDir: '/sessions',
      },
      { effects, resolve },
    );

    expect(outcome.resolutions).toHaveLength(1);
    expect(calls[0]).toEqual({
      pr: 45,
      repoRoot: '/repo',
      headBranch: 'feat/45',
      baseBranch: 'main',
      modelSpec: MODEL_SPEC,
      protectedBranch: 'trunk',
      wallClockMs: 1234,
      sessionsDir: '/sessions',
    });
  });

  test('conflict → escalate: needs-human row with the summary; NO second pass; never merged', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(escalated('a human must reconcile the semantics'));

    const outcome = await runMergePrs(baseInput([eligible(44), conflicting(45)], MODEL_SPEC), {
      effects,
      resolve,
    });

    // The decision is carried verbatim; nothing is re-guessed.
    expect(outcome.resolutions).toEqual([
      { pr: 45, decision: 'escalate', summary: 'a human must reconcile the semantics' },
    ]);
    // A non-acted outcome earns NO second pass.
    expect(outcome.secondPass).toBeNull();
    // The escalation is the union row (priority: escalation first — it
    // outranks the planner's 'not_eligible' for the same pr), and the pr
    // is in NO merged bucket.
    expect(outcome.needsHuman).toEqual([
      { pr: 45, reason: 'a human must reconcile the semantics' },
    ]);
    expect(outcome.firstPass.merged).toEqual([44]);
    expect(outcome.secondPass?.merged).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test('conflicts + modelSpec absent: needsHuman rows name modelSpec; resolve NEVER called', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(acted(45));

    const outcome = await runMergePrs(baseInput([conflicting(44), conflicting(45)]), {
      effects,
      resolve,
    });

    expect(outcome.secondPass).toBeNull();
    expect(outcome.resolutions).toEqual([]);
    expect(outcome.needsHuman).toEqual([
      { pr: 44, reason: MODEL_SPEC_REQUIRED_REASON },
      { pr: 45, reason: MODEL_SPEC_REQUIRED_REASON },
    ]);
    expect(calls).toEqual([]);
  });

  test('conflict → failed resolve: escalate with the did-not-complete prefix; NO second pass', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(resolveFailed('worktree add exploded'));

    const outcome = await runMergePrs(baseInput([conflicting(45)], MODEL_SPEC), {
      effects,
      resolve,
    });

    expect(outcome.resolutions).toEqual([
      {
        pr: 45,
        decision: 'escalate',
        summary: 'conflict agent did not complete: worktree add exploded',
      },
    ]);
    expect(outcome.secondPass).toBeNull();
    expect(outcome.needsHuman).toEqual([
      { pr: 45, reason: 'conflict agent did not complete: worktree add exploded' },
    ]);
    expect(calls).toHaveLength(1);
  });

  test('indeterminate and budget-exhausted verdicts escalate too (never silent, never guessed)', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve({
      status: 'indeterminate',
      detail: 'worker lost mid-run',
    });

    const indeterminate = await runMergePrs(baseInput([conflicting(45)], MODEL_SPEC), {
      effects,
      resolve,
    });
    expect(indeterminate.resolutions).toEqual([
      {
        pr: 45,
        decision: 'escalate',
        summary: 'conflict agent did not complete: worker lost mid-run',
      },
    ]);

    const { resolve: resolveBudget, calls: budgetCalls } = fakeResolve({
      status: 'budget-exhausted',
    });
    const budget = await runMergePrs(baseInput([conflicting(46)], MODEL_SPEC), {
      effects,
      resolve: resolveBudget,
    });
    expect(budget.resolutions).toEqual([
      {
        pr: 46,
        decision: 'escalate',
        summary: 'conflict agent did not complete: the conflict agent hit its budget bound',
      },
    ]);
    // Neither verdict earned a second pass.
    expect(indeterminate.secondPass).toBeNull();
    expect(budget.secondPass).toBeNull();
    expect(calls).toHaveLength(1);
    expect(budgetCalls).toHaveLength(1);
  });

  test('bounded concurrency: 3 conflicts, resolveConcurrency 2 → max 2 in flight, all resolved', async () => {
    const effects = new FakeMergeEffects();
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: ResolveConflictInput[] = [];
    const resolve = async (
      input: ResolveConflictInput,
    ): Promise<OpResult<ConflictResolutionValue>> => {
      calls.push(input);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A real (in-process) tick: without the p-limit cap all three would
      // overlap; with it, the third waits for a slot.
      await new Promise<void>((tick) => {
        setTimeout(tick, 10);
      });
      inFlight -= 1;
      return acted(input.pr);
    };

    const outcome = await runMergePrs(
      {
        ...baseInput([conflicting(46), conflicting(47), conflicting(48)], MODEL_SPEC),
        resolveConcurrency: 2,
      },
      { effects, resolve },
    );

    expect(calls).toHaveLength(3);
    expect(maxInFlight).toBe(2);
    expect(outcome.resolutions.map((resolution) => resolution.pr)).toEqual([46, 47, 48]);
  });

  test('resolveConcurrency < 1 is a loud caller error', async () => {
    const effects = new FakeMergeEffects();
    const { resolve } = fakeResolve(acted(45));
    await expect(
      runMergePrs(
        { ...baseInput([conflicting(45)], MODEL_SPEC), resolveConcurrency: 0 },
        { effects, resolve },
      ),
    ).rejects.toThrow('resolveConcurrency');
  });

  test('the needs-human union: escalation + planner withhold + failed merge, pr-sorted, deduped', async () => {
    const effects = new FakeMergeEffects();
    effects.mergeFailures.add(44); // the eligible pr's merge is refused
    const { resolve, calls } = fakeResolve(escalated('a human must reconcile the semantics'));

    const outcome = await runMergePrs(
      baseInput([draft(41), eligible(44), conflicting(45)], MODEL_SPEC),
      {
        effects,
        resolve,
      },
    );

    // No second pass: nothing acted.
    expect(outcome.secondPass).toBeNull();
    expect(outcome.firstPass.merged).toEqual([]);
    // Dedupe + priority pinned on pr 45: it is BOTH an escalation AND a
    // planner withhold ('not_eligible' — it is conflicting) — the decided
    // escalation's summary wins, the planner's gate reason does not.
    expect(outcome.needsHuman).toEqual([
      { pr: 41, reason: 'not_eligible' },
      { pr: 44, reason: 'gh pr merge 44 --merge failed (exit 1): refused by the forge' },
      { pr: 45, reason: 'a human must reconcile the semantics' },
    ]);
    // The final report is pass 1, so its post-mortem names the failed merge.
    expect(outcome.diagnosis.needsHuman).toEqual([44]);
    expect(calls).toHaveLength(1);
  });

  test('determinism: same input + same nowMs → deep-equal outcome (acted, unflipped data)', async () => {
    const run = async (): Promise<unknown> => {
      const effects = new FakeMergeEffects();
      const { resolve } = fakeResolve(acted(45));
      return runMergePrs(baseInput([eligible(44), conflicting(45)], MODEL_SPEC), {
        effects,
        resolve,
      });
    };

    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    // And the shape is the honest one for a claimed-but-unobserved flip:
    // the agent acted, the second pass ran on the guarded set (the
    // pass-1-merged pr 44 is excluded, so it is not re-merged), the data
    // still says DIRTY for 45, so the final plan withholds the pr and the
    // union carries it.
    const outcome = (await run()) as Awaited<ReturnType<typeof runMergePrs>>;
    expect(outcome.secondPass).not.toBeNull();
    expect(outcome.secondPass?.merged).toEqual([]);
    expect(outcome.needsHuman).toEqual([{ pr: 45, reason: 'not_eligible' }]);
  });

  test('the default op completes an empty run end to end — zero processes, zero driver runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runprs-empty-'));
    try {
      const runs: OpInvocation[] = [];
      const driver: Driver = {
        run: async (invocation: OpInvocation): Promise<WorkerResult> => {
          runs.push(invocation);
          return { usage: ZERO_USAGE, denials: [], stopReason: 'complete' };
        },
      };
      const op = makeRunMergePrsOp({ driver });

      const result = await op({ baseBranch: 'main', repoRoot: dir, prs: [], nowMs: NOW_MS });

      expect(result).toEqual({
        status: 'ok',
        value: {
          firstPass: { merged: [], retargeted: [], stale: [], failed: [], blocked: [] },
          secondPass: null,
          resolutions: [],
          needsHuman: [],
          diagnosis: {
            summary:
              'merge run: 0 merged, 0 retargeted, 0 need a human (state_drift: 0, merge_rejected: 0, blocked_by_ancestor: 0)',
            needsHuman: [],
            causes: [],
          },
        },
      });
      // Nothing conflicted, so the resolve path — and the driver behind it
      // — never ran.
      expect(runs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
